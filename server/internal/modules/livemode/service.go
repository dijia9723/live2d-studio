package livemode

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"server/internal/model"
	"server/internal/modules/agent"
	"server/internal/modules/character"
	"server/internal/modules/settings"
)

const eventLimit = 80
const replyLimit = 16

type Event struct {
	ID     int       `json:"id"`
	Kind   Kind      `json:"kind"`
	Viewer string    `json:"viewer"`
	Text   string    `json:"text,omitempty"`
	Count  uint64    `json:"count"`
	At     time.Time `json:"at"`
	key    string
}

type Reply struct {
	ID         int                 `json:"id"`
	Text       string              `json:"text,omitempty"`
	Error      string              `json:"error,omitempty"`
	At         time.Time           `json:"at"`
	EventIDs   []int               `json:"event_ids"`
	Stage      []agent.StageAction `json:"stage,omitempty"`
	Expression string              `json:"expression,omitempty"`
}

type Snapshot struct {
	connection
	Config    Config          `json:"config"`
	SessionID string          `json:"session_id"`
	Running   bool            `json:"running"`
	Demo      bool            `json:"demo"`
	Busy      bool            `json:"busy"`
	Counts    map[Kind]uint64 `json:"counts"`
	Events    []Event         `json:"events"`
	Replies   []Reply         `json:"replies"`
	Pending   int             `json:"pending"`
	AutoReady bool            `json:"auto_ready"`
	Draft     string          `json:"draft,omitempty"`
}

type session struct {
	id          string
	ctx         context.Context
	stop        context.CancelFunc
	stopReply   context.CancelFunc
	character   model.Character
	demo        bool
	status      connection
	events      []Event
	counts      map[Kind]uint64
	replies     []Reply
	recentKeys  map[string]struct{}
	keyOrder    []string
	replied     map[int]bool
	cursor      int
	nextEvent   int
	nextReply   int
	lastReplyAt time.Time
	draft       string
}

type Service struct {
	mu      sync.Mutex
	db      *gorm.DB
	models  *settings.Service
	roles   *character.Service
	agent   agent.Streamer
	config  Config
	session *session
}

func New(db *gorm.DB, models *settings.Service, roles *character.Service, streamer agent.Streamer) (*Service, error) {
	config, err := loadConfig(db)
	if err != nil {
		return nil, err
	}
	return &Service{db: db, models: models, roles: roles, agent: streamer, config: config}, nil
}

func (s *Service) Configure(config Config) error {
	if err := config.normalize(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	run := s.session
	if run != nil && run.ctx.Err() == nil &&
		(config.Room != s.config.Room || config.PollSeconds != s.config.PollSeconds || config.CharacterID != s.config.CharacterID) {
		return errors.New("结束连接后可以更换直播间、角色或开播轮询周期")
	}
	value, err := json.Marshal(config)
	if err != nil {
		return err
	}
	if err := s.db.Save(&model.Setting{ID: configRecordID, Value: string(value)}).Error; err != nil {
		return errors.New("保存直播配置失败")
	}
	if run != nil && config.Mode == "paused" && s.config.Mode != "paused" {
		run.cursor = run.nextEvent
		if run.stopReply != nil {
			run.stopReply()
		}
	}
	if run != nil && s.config.Mode == "paused" && config.Mode != "paused" {
		run.cursor = run.nextEvent
	}
	s.config = config
	return nil
}

func (s *Service) Start(demo bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.session != nil && s.session.ctx.Err() == nil {
		return errors.New("当前直播连接仍在运行")
	}
	config := s.config
	if !demo && config.Room == "" {
		return errors.New("请先配置抖音直播间")
	}
	role, err := s.roles.Get(config.CharacterID)
	if err != nil {
		return errors.New("请选择直播角色")
	}
	ctx, cancel := context.WithCancel(context.Background())
	run := &session{
		id: uuid.NewString(), ctx: ctx, stop: cancel, character: role, demo: demo,
		status: connection{Phase: "checking"}, counts: map[Kind]uint64{}, recentKeys: map[string]struct{}{}, replied: map[int]bool{},
	}
	s.session = run
	if demo {
		run.status = connection{Phase: "demo", Title: "直播演练"}
		for _, kind := range kinds {
			s.appendEvent(run, demoEvent(kind))
		}
		return nil
	}
	go douyinSource(ctx, config, func(event Event) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.session == run && ctx.Err() == nil {
			s.appendEvent(run, event)
		}
	}, func(status connection) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.session == run && ctx.Err() == nil {
			run.status = status
		}
	})
	return nil
}

func (s *Service) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if run := s.session; run != nil {
		run.stop()
		run.status = connection{Phase: "stopped", Title: run.status.Title}
	}
}

func (s *Service) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := Snapshot{Config: s.config, connection: connection{Phase: "stopped"}}
	if run := s.session; run != nil {
		state.SessionID, state.Running, state.Demo, state.Busy = run.id, run.ctx.Err() == nil, run.demo, run.ctx.Err() == nil && run.stopReply != nil
		state.connection = run.status
		if state.Busy {
			state.Draft = run.draft
		}
		state.Events, state.Replies, state.Counts = slices.Clone(run.events), slices.Clone(run.replies), maps.Clone(run.counts)
		if state.Running && s.config.Mode == "auto" {
			now := time.Now()
			for _, event := range run.events {
				if s.eligible(run, event, now) {
					state.Pending++
				}
			}
			state.AutoReady = state.Pending > 0 && !state.Busy && now.Sub(run.lastReplyAt) >= time.Duration(s.config.ReplySeconds)*time.Second
		}
	}
	return state
}

func (s *Service) appendEvent(run *session, event Event) {
	if !slices.Contains(s.config.Events, event.Kind) {
		return
	}
	if event.key != "" {
		if _, seen := run.recentKeys[event.key]; seen {
			return
		}
		if len(run.keyOrder) >= 512 {
			delete(run.recentKeys, run.keyOrder[0])
			run.keyOrder = run.keyOrder[1:]
		}
		run.recentKeys[event.key] = struct{}{}
		run.keyOrder = append(run.keyOrder, event.key)
	}
	run.nextEvent++
	event.ID = run.nextEvent
	event.Viewer = limitText(event.Viewer, 40)
	event.Text = limitText(event.Text, 280)
	event.Count = min(max(1, event.Count), 1<<31)
	if event.At.IsZero() {
		event.At = time.Now()
	}
	run.counts[event.Kind] += event.Count
	if len(run.events) == eventLimit {
		delete(run.replied, run.events[0].ID)
		run.events = run.events[1:]
	}
	run.events = append(run.events, event)
}

func limitText(value string, limit int) string {
	text := []rune(strings.TrimSpace(value))
	return string(text[:min(len(text), limit)])
}

func demoEvent(kind Kind) Event {
	switch kind {
	case Chat:
		return Event{Kind: kind, Viewer: "云朵", Text: "今天直播有什么安排？"}
	case Gift:
		return Event{Kind: kind, Viewer: "小橘", Text: "小心心", Count: 3}
	case Like:
		return Event{Kind: kind, Viewer: "阿星", Count: 16}
	case Enter:
		return Event{Kind: kind, Viewer: "夜风"}
	default:
		return Event{Kind: kind, Viewer: "青禾"}
	}
}

func (s *Service) AddDemoEvent(kind Kind) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.session == nil || !s.session.demo || s.session.ctx.Err() != nil {
		return errors.New("请先开启直播演练")
	}
	if !slices.Contains(s.config.Events, kind) {
		return errors.New("该类型的事件接收已关闭")
	}
	s.appendEvent(s.session, demoEvent(kind))
	return nil
}
