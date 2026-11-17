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

var ErrBusy = errors.New("此会话正在生成回复，请先停止生成")

type Service struct {
	DB         *gorm.DB
	Characters *character.Service
	Settings   *settings.Service
	Agent      agent.Streamer
	locks      sync.Map
}
type Event struct {
	Type       string         `json:"type"`
	Text       string         `json:"text,omitempty"`
	Expression string         `json:"expression,omitempty"`
	Message    *model.Message `json:"message,omitempty"`
}

func (s *Service) lock(id string) *sync.Mutex {
	v, _ := s.locks.LoadOrStore(id, &sync.Mutex{})
	return v.(*sync.Mutex)
}
func (s *Service) List() ([]model.Conversation, error) {
	v := []model.Conversation{}
	err := s.DB.Order("updated_at desc").Find(&v).Error
	return v, err
}
func (s *Service) Get(id string) (model.Conversation, error) {
	var v model.Conversation
	err := s.DB.First(&v, "id = ?", id).Error
	return v, err
}
func (s *Service) Create(characterID string) (model.Conversation, error) {
	v := model.Conversation{ID: uuid.NewString(), CharacterID: characterID, Title: "新的对话"}
	if _, err := s.Characters.Get(characterID); err != nil {
		return v, err
	}
	err := s.DB.Create(&v).Error
	return v, err
}
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
func (s *Service) Messages(id string) ([]model.Message, error) {
	if _, err := s.Get(id); err != nil {
		return nil, err
	}
	v := []model.Message{}
	err := s.DB.Where("conversation_id = ?", id).Order("created_at asc, rowid asc").Find(&v).Error
	return v, err
}
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
	history := []model.Message{}
	if err = s.DB.Where("conversation_id = ? AND status = ?", id, "complete").Order("created_at desc, rowid desc").Limit(cfg.LLM.ContextMessages).Find(&history).Error; err != nil {
		return err
	}
	for i, j := 0, len(history)-1; i < j; i, j = i+1, j-1 {
		history[i], history[j] = history[j], history[i]
	}
	for len(history) > 0 && history[0].Role != "user" {
		history = history[1:]
	}
	user := model.Message{ID: uuid.NewString(), ConversationID: id, Role: "user", Content: text, Image: image, Status: "complete"}
	if err = s.DB.Create(&user).Error; err != nil {
		return err
	}
	if conv.Title == "新的对话" {
		title := []rune(text)
		if len(title) > 28 {
			title = title[:28]
		}
		conv.Title = string(title)
	}
	if err = s.DB.Save(&conv).Error; err != nil {
		return err
	}
	emit(Event{Type: "user", Message: &user})
	history = append(history, user)
	assistant := model.Message{ID: uuid.NewString(), ConversationID: id, Role: "assistant", Status: "complete"}
	err = s.Agent.Stream(ctx, cfg.LLM, char, history, func(e agent.Event) {
		if e.Type == "delta" {
			assistant.Content += e.Text
		}
		emit(Event{Type: e.Type, Text: e.Text, Expression: e.Expression})
	})
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
