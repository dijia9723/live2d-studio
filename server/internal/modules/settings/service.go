package settings

import (
	"encoding/json"
	"sync"

	"server/internal/config"
	"server/internal/model"

	"gorm.io/gorm"
)

type Record = model.Setting
type Values = config.Settings
type Service struct {
	db       *gorm.DB
	defaults Values
	mu       sync.Mutex
}

func New(db *gorm.DB, cfg config.Config) *Service {
	return &Service{db: db, defaults: Values{LLM: cfg.LLM, Speech: cfg.Speech}}
}
func (s *Service) Raw() (Values, error) {
	v := s.defaults
	var row Record
	err := s.db.First(&row, 1).Error
	if err == gorm.ErrRecordNotFound {
		return v, nil
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal([]byte(row.Value), &v)
	return v, err
}
func (s *Service) Get() (Values, error) {
	v, err := s.Raw()
	cfg := config.Effective(config.Settings{LLM: v.LLM, Speech: v.Speech})
	v.LLM = cfg.LLM
	v.Speech = cfg.Speech
	return v, err
}
func (s *Service) Save(v Values, clearLLM, clearSpeech bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	old, err := s.Raw()
	if err != nil {
		return err
	}
	if v.LLM.APIKey == "" {
		v.LLM.APIKey = old.LLM.APIKey
	}
	if clearLLM {
		v.LLM.APIKey = ""
	}
	if v.Speech.APIKey == "" {
		v.Speech.APIKey = old.Speech.APIKey
	}
	if clearSpeech {
		v.Speech.APIKey = ""
	}
	if err = config.Validate(config.Settings{LLM: v.LLM, Speech: v.Speech}); err != nil {
		return err
	}
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return s.db.Save(&Record{ID: 1, Value: string(data)}).Error
}
