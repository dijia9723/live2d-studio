package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

type LLM struct {
	BaseURL         string  `json:"base_url" yaml:"base_url"`
	APIKey          string  `json:"api_key" yaml:"api_key"`
	Model           string  `json:"model" yaml:"model"`
	Temperature     float32 `json:"temperature" yaml:"temperature"`
	MaxTokens       int     `json:"max_tokens" yaml:"max_tokens"`
	ContextMessages int     `json:"context_messages" yaml:"context_messages"`
	ToolsEnabled    bool    `json:"tools_enabled" yaml:"tools_enabled"`
}

type Speech struct {
	Mode     string `json:"mode" yaml:"mode"`
	BaseURL  string `json:"base_url" yaml:"base_url"`
	APIKey   string `json:"api_key" yaml:"api_key"`
	ASRModel string `json:"asr_model" yaml:"asr_model"`
	TTSModel string `json:"tts_model" yaml:"tts_model"`
	Voice    string `json:"voice" yaml:"voice"`
	Language string `json:"language" yaml:"language"`
}

type Settings struct {
	LLM    LLM    `json:"llm" yaml:"llm"`
	Speech Speech `json:"speech" yaml:"speech"`
}

type Config struct {
	Host     string `yaml:"host"`
	Port     int    `yaml:"port"`
	DataDir  string `yaml:"data_dir"`
	Settings `yaml:",inline"`
}

func Defaults() Config {
	return Config{Host: "127.0.0.1", Port: 12393, DataDir: "data", Settings: Settings{
		LLM:    LLM{BaseURL: "https://api.openai.com/v1", Model: "gpt-4o-mini", Temperature: 0.7, MaxTokens: 2048, ContextMessages: 40},
		Speech: Speech{Mode: "browser", BaseURL: "https://api.openai.com/v1", ASRModel: "whisper-1", TTSModel: "tts-1", Voice: "alloy", Language: "zh-CN"},
	}}
}

func Load(path string) (Config, error) {
	cfg := Defaults()
	data, err := os.ReadFile(path)
	if err == nil {
		if err = yaml.Unmarshal(data, &cfg); err != nil {
			return cfg, fmt.Errorf("读取配置: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return cfg, err
	}
	if !filepath.IsAbs(cfg.DataDir) {
		cfg.DataDir = filepath.Join(filepath.Dir(filepath.Dir(path)), cfg.DataDir)
	}
	if host := os.Getenv("STUDIO_HOST"); host != "" {
		cfg.Host = host
	}
	if port := os.Getenv("STUDIO_PORT"); port != "" {
		cfg.Port, err = strconv.Atoi(port)
		if err != nil {
			return cfg, fmt.Errorf("STUDIO_PORT 无效")
		}
	}
	if dir := os.Getenv("STUDIO_DATA_DIR"); dir != "" {
		cfg.DataDir = dir
	}
	if cfg.Host != "localhost" && (net.ParseIP(cfg.Host) == nil || !net.ParseIP(cfg.Host).IsLoopback()) && !(cfg.Host == "0.0.0.0" && os.Getenv("STUDIO_CONTAINER") == "1") {
		return cfg, fmt.Errorf("桌面服务只允许绑定回环地址")
	}
	if cfg.Port < 0 || cfg.Port > 65535 {
		return cfg, fmt.Errorf("port 必须在 0–65535 之间")
	}
	return cfg, Validate(cfg.Settings)
}

// Effective applies environment overrides at the boundary; they are never persisted.
func Effective(s Settings) Settings {
	if v := os.Getenv("STUDIO_LLM_API_KEY"); v != "" {
		s.LLM.APIKey = v
	}
	if v := os.Getenv("STUDIO_LLM_BASE_URL"); v != "" {
		s.LLM.BaseURL = v
	}
	if v := os.Getenv("STUDIO_LLM_MODEL"); v != "" {
		s.LLM.Model = v
	}
	if v := os.Getenv("STUDIO_SPEECH_API_KEY"); v != "" {
		s.Speech.APIKey = v
	}
	return s
}

func Validate(s Settings) error {
	for _, raw := range []string{s.LLM.BaseURL, s.Speech.BaseURL} {
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return fmt.Errorf("服务地址必须是有效的 HTTP(S) 地址，且不含认证信息、查询或片段")
		}
	}
	if strings.TrimSpace(s.LLM.Model) == "" {
		return fmt.Errorf("模型名称不能为空")
	}
	if s.LLM.Temperature < 0 || s.LLM.Temperature > 2 || s.LLM.MaxTokens < 1 || s.LLM.MaxTokens > 131072 || s.LLM.ContextMessages < 2 || s.LLM.ContextMessages > 200 {
		return fmt.Errorf("模型参数超出范围")
	}
	if s.Speech.Mode != "browser" && s.Speech.Mode != "api" && s.Speech.Mode != "off" {
		return fmt.Errorf("不支持的语音模式")
	}
	if s.Speech.ASRModel == "" || s.Speech.TTSModel == "" || s.Speech.Voice == "" {
		return fmt.Errorf("语音模型和音色不能为空")
	}
	return nil
}
