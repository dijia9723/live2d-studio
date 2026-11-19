// 本文件实现配置的读取、环境变量覆盖与密钥“留空保留/显式清除”的保存语义。

package settings

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"sync"

	"server/internal/config"
	"server/internal/model"

	"gorm.io/gorm"
)

// Record 是设置表的单行记录，ID 固定为 1。
type Record = model.Setting

// Values 是持久化的模型与语音配置。
type Values = config.Settings

// 保留旧单行记录的 llm/speech 字段，同时按服务保存地址、模型、参数和各自的密钥。
type storedValues struct {
	Values
	Profiles    map[string]config.LLM `json:"llm_profiles"`
	ScreenWatch ScreenWatchModels     `json:"screen_watch,omitempty"`
}

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

// load 同时读取当前配置和各服务存档，并兼容旧版本单份配置。
func (s *Service) load() (storedValues, error) {
	v := storedValues{Values: s.defaults, Profiles: map[string]config.LLM{}}
	var row Record
	err := s.db.First(&row, 1).Error
	if err == gorm.ErrRecordNotFound {
		v.LLM.Provider = legacyProvider(v.LLM)
		return v, nil
	}
	if err != nil {
		return v, err
	}
	err = json.Unmarshal([]byte(row.Value), &v)
	if err != nil {
		return v, err
	}
	if len(v.Profiles) == 0 {
		// 旧版本只有当前一份配置：识别服务后完整保留，不覆盖为预设值。
		v.LLM.Provider = legacyProvider(v.LLM)
		v.Profiles = map[string]config.LLM{v.LLM.Provider: v.LLM}
	}
	return v, err
}

func legacyProvider(v config.LLM) string {
	if v.Provider != "" && v.Provider != "openai" {
		return v.Provider
	}
	u, err := url.Parse(v.BaseURL)
	if err == nil {
		host := strings.ToLower(u.Hostname())
		switch {
		case host == "deepseek.com" || strings.HasSuffix(host, ".deepseek.com"):
			return "deepseek"
		case u.Port() == "11434":
			return "ollama"
		case u.Port() == "1234":
			return "lmstudio"
		}
	}
	return "openai"
}

// Raw 读取数据库中保存的原始配置（不应用环境变量），无记录时返回启动默认值。
func (s *Service) Raw() (Values, error) {
	v, err := s.load()
	return v.Values, err
}

// Profile 读取指定服务的原始配置；没有存档时使用后端预设，不应用其它服务的密钥或环境覆盖。
func (s *Service) Profile(provider string) (config.LLM, bool, error) {
	fallback, ok := config.LLMProviderDefaults(provider)
	if !ok {
		return config.LLM{}, false, fmt.Errorf("不支持的模型服务类型")
	}
	v, err := s.load()
	if err != nil {
		return config.LLM{}, false, err
	}
	if profile, found := v.Profiles[provider]; found {
		profile.Provider = provider
		return profile, true, nil
	}
	if v.LLM.Provider == provider {
		return v.LLM, false, nil // 没有数据库记录时保留启动配置。
	}
	return fallback, false, nil
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
	old, err := s.load()
	if err != nil {
		return err
	}
	if v.LLM.Provider == "" {
		v.LLM.Provider = legacyProvider(v.LLM)
	}
	if v.LLM.APIKey == "" {
		previous, found := old.Profiles[v.LLM.Provider]
		if !found && old.LLM.Provider == v.LLM.Provider {
			previous = old.LLM
		}
		v.LLM.APIKey = previous.APIKey
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
	old.Values = v
	old.Profiles[v.LLM.Provider] = v.LLM
	data, err := json.Marshal(old)
	if err != nil {
		return err
	}
	return s.db.Save(&Record{ID: 1, Value: string(data)}).Error
}
