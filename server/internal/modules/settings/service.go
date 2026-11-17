// 本文件实现配置的读取、环境变量覆盖与密钥“留空保留/显式清除”的保存语义。

package settings

import (
	"encoding/json"
	"sync"

	"server/internal/config"
	"server/internal/model"

	"gorm.io/gorm"
)

// Record 是设置表的单行记录，ID 固定为 1。
type Record = model.Setting

// Values 是持久化的模型与语音配置。
type Values = config.Settings

// Service 负责设置的读取与保存，并用互斥锁串行化写入，避免并发保存互相覆盖密钥。
type Service struct {
	db       *gorm.DB
	defaults Values
	mu       sync.Mutex
}

// New 记录配置默认值，作为数据库中没有设置记录时的回退。
func New(db *gorm.DB, cfg config.Config) *Service {
	return &Service{db: db, defaults: Values{LLM: cfg.LLM, Speech: cfg.Speech}}
}

// Raw 读取数据库中保存的原始配置（不应用环境变量），无记录时返回启动默认值。
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

// Get 返回应用环境变量覆盖后的生效配置，用于界面展示与实际请求；
// 环境变量覆盖不会被持久化。
func (s *Service) Get() (Values, error) {
	v, err := s.Raw()
	cfg := config.Effective(config.Settings{LLM: v.LLM, Speech: v.Speech})
	v.LLM = cfg.LLM
	v.Speech = cfg.Speech
	return v, err
}

// Save 保存配置：API Key 留空表示保留旧值（界面不回传密钥），Clear* 为真时显式清空；
// 写入前统一校验服务地址与模型参数，避免持久化无法使用的配置。
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
