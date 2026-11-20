package livemode

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"server/internal/model"
	"server/internal/modules/agent"
)

func (s *Service) eligible(run *session, event Event, now time.Time) bool {
	return event.ID > run.cursor && !run.replied[event.ID] && now.Sub(event.At) <= 2*time.Minute &&
		slices.Contains(s.config.ReplyEvents, event.Kind)
}

func eventPriority(event Event) int {
	switch event.Kind {
	case Chat:
		if strings.ContainsAny(event.Text, "？?") {
			return 5
		}
		return 3
	case Gift:
		return 4
	case Follow:
		return 2
	case Enter:
		return 1
	default:
		return 0
	}
}

// RequestReply accepts one bounded batch. Zero eventID requests automatic selection.
func (s *Service) RequestReply(sessionID string, eventID int) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run := s.session
	if run == nil || run.id != sessionID || run.ctx.Err() != nil {
		return false, errors.New("直播连接已变化，请刷新后重试")
	}
	config := s.config
	if run.stopReply != nil || config.Mode == "paused" || run.archive == nil || run.archive.EndedAt != nil || run.status.offline {
		return false, nil
	}
	now := time.Now()
	var selected []Event
	if eventID != 0 {
		for _, event := range run.events {
			if event.ID == eventID {
				selected = []Event{event}
				break
			}
		}
		if len(selected) == 0 {
			return false, errors.New("该事件已从列表中移除")
		}
	} else {
		if config.Mode != "auto" || now.Sub(run.lastReplyAt) < time.Duration(config.ReplySeconds)*time.Second {
			return false, nil
		}
		for _, event := range run.events {
			if s.eligible(run, event, now) {
				selected = append(selected, event)
			}
		}
		if len(selected) == 0 {
			return false, nil
		}
		slices.SortStableFunc(selected, func(a, b Event) int {
			if priority := eventPriority(b) - eventPriority(a); priority != 0 {
				return priority
			}
			return b.ID - a.ID
		})
		selected = selected[:min(len(selected), config.BatchSize)]
		slices.SortFunc(selected, func(a, b Event) int { return a.ID - b.ID })
		run.cursor = run.nextEvent
	}
	for _, event := range selected {
		run.replied[event.ID] = true
	}
	run.lastReplyAt = now
	run.nextReply++
	run.draft = ""
	ctx, cancel := context.WithTimeout(run.ctx, 45*time.Second)
	run.stopReply = cancel
	input := run.replyContext(selected)
	go s.generate(ctx, cancel, run, config, run.archive.ID, run.nextReply, selected, input)
	return true, nil
}

func (s *Service) generate(ctx context.Context, cancel context.CancelFunc, run *session, config Config, archiveID string, replyID int, events []Event, input replyContext) {
	defer cancel()
	reply := Reply{ID: replyID, At: time.Now()}
	for _, event := range events {
		reply.EventIDs = append(reply.EventIDs, event.ID)
	}
	data, _ := json.Marshal(input)
	history := []model.Message{{Role: "user", Content: "请回应本轮直播事件。\n" + string(data)}}
	var text strings.Builder
	models, err := s.models.Get()
	if err == nil {
		models.LLM.Temperature, models.LLM.MaxTokens, models.LLM.ToolsEnabled = config.Temperature, config.MaxTokens, config.Actions
		err = s.agent.Stream(agent.WithLiveAudience(ctx, config.Prompt), models.LLM, run.character, history, func(event agent.Event) {
			switch event.Type {
			case "delta":
				if text.Len() < 16000 {
					text.WriteString(event.Text)
				}
				s.mu.Lock()
				if s.session == run && ctx.Err() == nil {
					run.draft = limitText(text.String(), 900)
				}
				s.mu.Unlock()
			case "expression":
				reply.Expression = event.Expression
			case "stage_action":
				if event.StageAction != nil && len(reply.Stage) < 2 {
					reply.Stage = append(reply.Stage, *event.StageAction)
				}
			}
		})
	}
	reply.Text = limitText(text.String(), 1500)
	if err != nil {
		reply.Error = agent.ErrorMessage(err)
	} else if reply.Text == "" {
		reply.Error = "模型未返回可播报的文字"
	}
	reply.At = time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.session != run {
		return
	}
	run.stopReply, run.draft = nil, ""
	if run.ctx.Err() != nil || errors.Is(ctx.Err(), context.Canceled) || run.archive == nil || run.archive.ID != archiveID {
		return
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		reply.Error = "直播回复超时"
	}
	row := model.LiveReply{SessionID: archiveID, ID: reply.ID, Text: reply.Text, Error: reply.Error, EventIDs: reply.EventIDs, At: reply.At}
	if err := s.db.Create(&row).Error; err != nil {
		s.archiveWriteFailed(run)
	}
	if len(run.replies) == replyLimit {
		run.replies = run.replies[1:]
	}
	run.replies = append(run.replies, reply)
}
