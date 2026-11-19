// 本文件实现会话的业务逻辑：锁、会话与消息的持久化、对话编排与自动标题。

package conversation

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"server/internal/model"
	"server/internal/modules/agent"
	"server/internal/modules/character"
	"server/internal/modules/settings"
)

// ErrBusy 表示该会话已有生成请求在运行；TryLock 失败时直接返回，
// 避免两轮回复交错写入同一会话的历史。
var ErrBusy = errors.New("此会话正在生成回复，请先停止生成")

// defaultTitle 是新会话的初始标题，也是判断是否还需要自动生成标题的依据。
const defaultTitle = "新的对话"

// Service 组合数据库、角色、设置与 agent，并用会话级互斥锁串行化生成请求。
// locks 以会话 ID 为键缓存锁且从不删除：会话数量有限，省去清理锁时的并发竞态。
type Service struct {
	DB         *gorm.DB
	Characters *character.Service
	Settings   *settings.Service
	Agent      agent.Streamer
	locks      sync.Map
}

// Event 是推送给前端的 SSE 事件，包括 user、delta、expression、stage_action、character、tool、done 与 error。
type Event struct {
	Type        string             `json:"type"`
	Text        string             `json:"text,omitempty"`
	Expression  string             `json:"expression,omitempty"`
	Tool        *model.ToolRun     `json:"tool,omitempty"`
	Character   *model.Character   `json:"character,omitempty"`
	StageAction *agent.StageAction `json:"stage_action,omitempty"`
	Message     *model.Message     `json:"message,omitempty"`
}

// lock 返回会话对应的互斥锁，同一会话的生成与删除操作共享同一把锁。
func (s *Service) lock(id string) *sync.Mutex {
	v, _ := s.locks.LoadOrStore(id, &sync.Mutex{})
	return v.(*sync.Mutex)
}

// List 按更新时间倒序返回全部会话。
func (s *Service) List() ([]model.Conversation, error) {
	v := []model.Conversation{}
	err := s.DB.Order("updated_at desc").Find(&v).Error
	return v, err
}

// Get 按 ID 读取会话，不存在时返回 gorm.ErrRecordNotFound。
func (s *Service) Get(id string) (model.Conversation, error) {
	var v model.Conversation
	err := s.DB.First(&v, "id = ?", id).Error
	return v, err
}

// Create 先确认角色存在再创建会话，避免产生无法发送消息的空会话。
func (s *Service) Create(characterID string) (model.Conversation, error) {
	v := model.Conversation{ID: uuid.NewString(), CharacterID: characterID, Title: defaultTitle}
	if _, err := s.Characters.Get(characterID); err != nil {
		return v, err
	}
	err := s.DB.Create(&v).Error
	return v, err
}

// Delete 使用 TryLock 而非阻塞加锁：会话正在生成时立即返回 ErrBusy，
// 避免删除消息与流式写入互相打断；事务内先删消息再删会话记录。
func (s *Service) Delete(id string) error {
	mu := s.lock(id)
	if !mu.TryLock() {
		return ErrBusy
	}
	defer mu.Unlock()
	return s.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("conversation_id = ?", id).Delete(&model.Message{}).Error; err != nil {
			return err
		}
		res := tx.Delete(&model.Conversation{}, "id = ?", id)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}
		return nil
	})
}

// Messages 返回会话的全部消息，按创建时间与 rowid 升序保证顺序稳定。
func (s *Service) Messages(id string) ([]model.Message, error) {
	if _, err := s.Get(id); err != nil {
		return nil, err
	}
	v := []model.Message{}
	err := s.DB.Where("conversation_id = ?", id).Order("created_at asc, rowid asc").Find(&v).Error
	return v, err
}

// Stream 完成一轮对话：抢会话锁、读取角色/设置/裁剪后的历史、记录用户消息，
// 再流式转发模型事件，最后把助手回复与工具运行状态整体落库并推送 done 事件。
// 锁保证同一会话不会并发生成；ctx 取消时回复标记为 interrupted；空回复按失败处理；
// 仍处于 running 的工具状态统一降级为 failed，避免前端一直显示运行中。
func (s *Service) Stream(ctx context.Context, id, text, image string, emit func(Event)) error {
	mu := s.lock(id)
	if !mu.TryLock() {
		return ErrBusy
	}
	defer mu.Unlock()
	conv, err := s.Get(id)
	if err != nil {
		return err
	}
	char, err := s.Characters.Get(conv.CharacterID)
	if err != nil {
		return err
	}
	cfg, err := s.Settings.Get()
	if err != nil {
		return err
	}
	history, err := s.recentContext(ctx, id, cfg.LLM.ContextMessages)
	if err != nil {
		return err
	}
	user := model.Message{ID: uuid.NewString(), ConversationID: id, Role: "user", Content: text, Image: image, Status: "complete"}
	if err = s.recordUser(ctx, &user); err != nil {
		return err
	}
	emit(Event{Type: "user", Message: &user})
	modelInput, llm := s.withScreenObservation(ctx, user, cfg.LLM)
	history = append(history, modelInput)
	assistant := model.Message{ID: uuid.NewString(), ConversationID: id, Role: "assistant", Status: "complete"}
	var content strings.Builder
	toolIndexes := make(map[string]int)
	err = s.Agent.Stream(ctx, llm, char, history, func(e agent.Event) {
		if e.Type == "delta" {
			content.WriteString(e.Text)
		}
		if e.Tool != nil {
			if index, exists := toolIndexes[e.Tool.ID]; exists {
				assistant.ToolRuns[index] = *e.Tool
			} else {
				toolIndexes[e.Tool.ID] = len(assistant.ToolRuns)
				assistant.ToolRuns = append(assistant.ToolRuns, *e.Tool)
			}
		}
		emit(Event{Type: e.Type, Text: e.Text, Expression: e.Expression, Tool: e.Tool, Character: e.Character, StageAction: e.StageAction})
	})
	assistant.Content = content.String()
	for i := range assistant.ToolRuns {
		if assistant.ToolRuns[i].Status == model.ToolRunning {
			assistant.ToolRuns[i].Status = model.ToolFailed
		}
	}
	if err != nil {
		assistant.Status = "failed"
		assistant.Error = agent.ErrorMessage(err)
		if ctx.Err() != nil {
			assistant.Status = "interrupted"
			assistant.Error = agent.ErrorMessage(ctx.Err())
		}
	}
	if err == nil && strings.TrimSpace(assistant.Content) == "" {
		assistant.Status = "failed"
		err = agent.ErrEmptyResponse
		assistant.Error = agent.ErrorMessage(err)
	}
	if saveErr := s.DB.Create(&assistant).Error; saveErr != nil {
		return fmt.Errorf("保存回复失败: %w", saveErr)
	}
	emit(Event{Type: "done", Message: &assistant})
	return err
}

// recordUser 写入用户消息，并在会话仍为默认标题且此前没有用户消息时自动生成标题。
// 标题截取前 28 个字符；判断与更新在同一事务内完成，避免覆盖用户并发重命名的结果。
func (s *Service) recordUser(ctx context.Context, user *model.Message) error {
	title := []rune(strings.TrimSpace(user.Content))
	if len(title) > 28 {
		title = title[:28]
	}
	return s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 在写入时读取标题，保证并发的重命名结果不会被覆盖。
		previousUser := tx.Model(&model.Message{}).Select("1").
			Where("conversation_id = ? AND role = ?", user.ConversationID, "user")
		result := tx.Model(&model.Conversation{}).Where("id = ?", user.ConversationID).
			Update("title", gorm.Expr("CASE WHEN title = ? AND NOT EXISTS (?) THEN ? ELSE title END", defaultTitle, previousUser, string(title)))
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}
		return tx.Create(user).Error
	})
}
