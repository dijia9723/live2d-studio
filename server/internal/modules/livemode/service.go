// Package livemode 负责监听抖音直播间、聚合互动事件、触发 AI 自动回应，并把每场直播归档供事后复盘。
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

// 内存窗口只保留最近的互动数据：直播可能持续数小时，若不设上限会持续占用内存，
// 也会让状态接口每次返回的内容越来越大。
const eventLimit = 80
const replyLimit = 16
const recentChatLimit = 64

// Event 表示一条归一化后的直播互动事件，ID 在单场直播内自增且唯一。
type Event struct {
	ID       int       `json:"id"`
	Kind     Kind      `json:"kind"`
	Viewer   string    `json:"viewer"`
	Text     string    `json:"text,omitempty"`
	Count    uint64    `json:"count"`
	At       time.Time `json:"at"`
	key      string
	viewerID uint64
}

// Reply 表示一次 AI 回应，包含台本文案、表情与动作，以及它针对的事件。
type Reply struct {
	ID         int                 `json:"id"`
	Text       string              `json:"text,omitempty"`
	Error      string              `json:"error,omitempty"`
	At         time.Time           `json:"at"`
	EventIDs   []int               `json:"event_ids"`
	Stage      []agent.StageAction `json:"stage,omitempty"`
	Expression string              `json:"expression,omitempty"`
}

// Snapshot 是对外暴露的直播状态快照，前端据此渲染连接状态、事件流与待回复提示。
type Snapshot struct {
	connection
	Config       Config          `json:"config"`
	SessionID    string          `json:"session_id"`
	Running      bool            `json:"running"`
	Busy         bool            `json:"busy"`
	Counts       map[Kind]uint64 `json:"counts"`
	Events       []Event         `json:"events"`
	Replies      []Reply         `json:"replies"`
	Pending      int             `json:"pending"`
	AutoReady    bool            `json:"auto_ready"`
	Draft        string          `json:"draft,omitempty"`
	RecordingID  string          `json:"recording_id,omitempty"`
	ArchiveError string          `json:"archive_error,omitempty"`
}

// session 是一次直播连接的运行时状态，只在持有 Service.mu 时读写。
// cursor/replied 用于防止同一条事件被重复回应。
type session struct {
	id           string
	ctx          context.Context
	stop         context.CancelFunc
	stopReply    context.CancelFunc
	character    model.Character
	status       connection
	events       []Event
	recentChats  []Event
	counts       map[Kind]uint64
	replies      []Reply
	recentKeys   map[string]struct{}
	keyOrder     []string
	replied      map[int]bool
	cursor       int
	nextEvent    int
	nextReply    int
	lastReplyAt  time.Time
	draft        string
	archive      *model.LiveSession
	archiveError string
	missedEvents bool
}

// Service 管理直播监听会话及其归档记录。
// 监听回调、HTTP 请求与 AI 生成协程会并发访问 session，因此所有可变状态统一由 mu 串行化。
type Service struct {
	mu      sync.Mutex
	db      *gorm.DB
	models  *settings.Service
	roles   *character.Service
	agent   agent.Streamer
	connect func(context.Context, Config, func(Event), func(connection))
	config  Config
	session *session
}

// New 创建直播服务并加载持久化配置；启动时把上次异常退出遗留的录制中记录标记为中断，
// 避免归档列表里出现永远无法结算的直播。
func New(db *gorm.DB, models *settings.Service, roles *character.Service, streamer agent.Streamer) (*Service, error) {
	config, err := loadConfig(db)
	if err != nil {
		return nil, err
	}
	if err := db.Model(&model.LiveSession{}).Where("status = ?", "recording").Update("status", "interrupted").Error; err != nil {
		return nil, err
	}
	return &Service{db: db, models: models, roles: roles, agent: streamer, connect: douyinSource, config: config}, nil
}

// Configure 校验并保存直播配置。连接运行期间不允许更换直播间、角色或轮询周期，
// 否则正在进行的监听协程会与配置不一致。
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

// Start 启动直播间监听。监听回调都先检查 session 仍是当前会话且未取消，
// 这样停止后重开的旧回调不会污染新会话。
func (s *Service) Start() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.session != nil && s.session.ctx.Err() == nil {
		return errors.New("当前直播连接仍在运行")
	}
	if s.session != nil {
		if err := s.finishArchive(s.session); err != nil {
			return err
		}
	}
	config := s.config
	if config.Room == "" {
		return errors.New("请先配置抖音直播间")
	}
	role, err := s.roles.Get(config.CharacterID)
	if err != nil {
		return errors.New("请选择直播角色")
	}
	ctx, cancel := context.WithCancel(context.Background())
	run := &session{
		id: uuid.NewString(), ctx: ctx, stop: cancel, character: role,
		status: connection{Phase: "checking"}, counts: map[Kind]uint64{}, recentKeys: map[string]struct{}{}, replied: map[int]bool{},
	}
	s.session = run
	go s.connect(ctx, config, func(event Event) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.session == run && ctx.Err() == nil {
			s.appendEvent(run, event)
		}
	}, func(status connection) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.session == run && ctx.Err() == nil {
			s.updateConnection(run, config.Room, status)
		}
	})
	return nil
}

// Stop 停止监听并结算当前直播归档；只有结算成功才会清理进行中的记录。
func (s *Service) Stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if run := s.session; run != nil {
		run.stop()
		run.status = connection{Phase: "stopped", Title: run.status.Title}
		return s.finishArchive(run)
	}
	return nil
}

// Snapshot 返回当前状态快照。切片与 map 都要克隆后再返回，
// 否则调用方在锁外序列化时会与监听回调的写入产生数据竞争。
func (s *Service) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := Snapshot{Config: s.config, connection: connection{Phase: "stopped"}}
	if run := s.session; run != nil {
		state.SessionID = run.id
		state.Running = run.ctx.Err() == nil
		state.Busy = state.Running && run.stopReply != nil
		state.connection = run.status
		state.ArchiveError = run.archiveError
		if run.archive != nil && run.archive.EndedAt == nil {
			state.RecordingID = run.archive.ID
		}
		if state.Busy {
			state.Draft = run.draft
		}
		state.Events, state.Replies, state.Counts = slices.Clone(run.events), slices.Clone(run.replies), maps.Clone(run.counts)
		if state.Running && state.RecordingID != "" && !run.status.offline && s.config.Mode == "auto" {
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

// appendEvent 过滤、去重并记录一条互动事件。
// key 相同说明是抖音重复推送的消息，用固定容量的顺序表淘汰旧 key 控制内存；
// 数据库写入失败只标记归档不完整，不影响直播继续进行。
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
	if run.archive != nil && run.archive.EndedAt == nil {
		row := model.LiveEvent{SessionID: run.archive.ID, ID: event.ID, Kind: string(event.Kind), Viewer: event.Viewer, Text: event.Text, Count: event.Count, At: event.At}
		if err := s.db.Create(&row).Error; err != nil {
			s.archiveWriteFailed(run)
		}
	} else {
		run.missedEvents = true
	}
	run.counts[event.Kind] += event.Count
	if len(run.events) == eventLimit {
		delete(run.replied, run.events[0].ID)
		run.events = run.events[1:]
	}
	run.events = append(run.events, event)
	if event.Kind == Chat && event.viewerID != 0 && event.Text != "" {
		if len(run.recentChats) == recentChatLimit {
			copy(run.recentChats, run.recentChats[1:])
			run.recentChats = run.recentChats[:recentChatLimit-1]
		}
		run.recentChats = append(run.recentChats, event)
	}
}

func limitText(value string, limit int) string {
	text := []rune(strings.TrimSpace(value))
	return string(text[:min(len(text), limit)])
}
