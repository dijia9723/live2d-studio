// Package config 定义配置结构、默认值、加载优先级与参数校验。
// 配置文件只提供初始值；环境变量在读取时覆盖，但绝不回写配置文件。
package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"server/internal/tts"

	"gopkg.in/yaml.v3"
)

// LLM 描述对话模型接入与生成参数。
type LLM struct {
	Provider    string  `json:"provider" yaml:"provider"`
	BaseURL     string  `json:"base_url" yaml:"base_url"`
	APIKey      string  `json:"api_key" yaml:"api_key"`
	Model       string  `json:"model" yaml:"model"`
	Temperature float32 `json:"temperature" yaml:"temperature"`
	MaxTokens   int     `json:"max_tokens" yaml:"max_tokens"`
	// ContextMessages 是随请求携带的历史消息条数上限（按完整问答轮次截断）。
	ContextMessages int `json:"context_messages" yaml:"context_messages"`
	// ToolsEnabled 控制是否向模型声明工具（表情、记忆检索等）。
	ToolsEnabled bool `json:"tools_enabled" yaml:"tools_enabled"`
}

// Speech 的 Mode 控制语音识别及默认朗读方式；LocalTTS 可单独覆盖朗读方式。
type Speech struct {
	Mode     string       `json:"mode" yaml:"mode"`
	BaseURL  string       `json:"base_url" yaml:"base_url"`
	APIKey   string       `json:"api_key" yaml:"api_key"`
	ASRModel string       `json:"asr_model" yaml:"asr_model"`
	TTSModel string       `json:"tts_model" yaml:"tts_model"`
	Voice    string       `json:"voice" yaml:"voice"`
	Language string       `json:"language" yaml:"language"`
	LocalTTS *tts.Options `json:"local_tts" yaml:"local_tts,omitempty"`
}

// Settings 是持久化到数据库、并可通过接口热更新的那部分配置。
type Settings struct {
	LLM    LLM    `json:"llm" yaml:"llm"`
	Speech Speech `json:"speech" yaml:"speech"`
}

// Config 是进程级配置：监听地址、数据目录，以及内联的 Settings。
type Config struct {
	Host         string `yaml:"host"`
	Port         int    `yaml:"port"`
	DataDir      string `yaml:"data_dir"`
	TTSDir       string `yaml:"tts_dir"`
	PiRuntimeDir string `yaml:"pi_runtime_dir"`
	Settings     `yaml:",inline"`
}

// Defaults 返回可离线启动的默认配置：只监听回环地址，语音默认交给浏览器。
func Defaults() Config {
	return Config{Host: "127.0.0.1", Port: 12393, DataDir: "data", TTSDir: "tts-models", PiRuntimeDir: "pi-runtime", Settings: Settings{
		LLM:    LLM{Provider: "openai", BaseURL: "https://api.openai.com/v1", Model: "gpt-4o-mini", Temperature: 0.7, MaxTokens: 2048, ContextMessages: 40},
		Speech: Speech{Mode: "browser", BaseURL: "https://api.openai.com/v1", ASRModel: "whisper-1", TTSModel: "tts-1", Voice: "alloy", Language: "zh-CN"},
	}}
}

// Load 读取 YAML 配置并叠加环境变量，最后做安全与范围校验。
//
// 优先级：内置默认值 < YAML < 环境变量（STUDIO_HOST/STUDIO_PORT/STUDIO_DATA_DIR）。
// 文件不存在时沿用默认值，便于首次启动；其他读取或解析错误直接返回。
// 相对 DataDir 以配置文件所在目录的上级为基准，因此数据目录与进程工作目录无关。
// 出于桌面应用安全考虑，Host 只允许回环地址；仅在 STUDIO_CONTAINER=1 时
// 放行 0.0.0.0，供容器端口映射使用。
func Load(path string) (Config, error) {
	cfg := Defaults()
	data, err := os.ReadFile(path)
	if err == nil {
		if err = yaml.Unmarshal(data, &cfg); err != nil {
			return cfg, fmt.Errorf("读取配置: %w", err)
		}
	} else if !os.IsNotExist(err) {
		// 只有“文件不存在”可以忽略，权限等其他错误必须暴露。
		return cfg, err
	}
	if !filepath.IsAbs(cfg.DataDir) {
		// path 位于 <根>/configs/config.yaml，取两级父目录即安装根，数据目录随之稳定。
		cfg.DataDir = filepath.Join(filepath.Dir(filepath.Dir(path)), cfg.DataDir)
	}
	if dir := os.Getenv("STUDIO_TTS_DIR"); dir != "" {
		cfg.TTSDir = dir
	}
	if !filepath.IsAbs(cfg.TTSDir) {
		cfg.TTSDir = filepath.Join(filepath.Dir(filepath.Dir(path)), cfg.TTSDir)
	}
	if dir := os.Getenv("STUDIO_PI_RUNTIME_DIR"); dir != "" {
		cfg.PiRuntimeDir = dir
	}
	if !filepath.IsAbs(cfg.PiRuntimeDir) {
		cfg.PiRuntimeDir = filepath.Join(filepath.Dir(filepath.Dir(path)), cfg.PiRuntimeDir)
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
	// 容器场景显式声明后才允许监听所有网卡，桌面环境始终限制在回环地址。
	if cfg.Host != "localhost" && (net.ParseIP(cfg.Host) == nil || !net.ParseIP(cfg.Host).IsLoopback()) && !(cfg.Host == "0.0.0.0" && os.Getenv("STUDIO_CONTAINER") == "1") {
		return cfg, fmt.Errorf("桌面服务只允许绑定回环地址")
	}
	if cfg.Port < 0 || cfg.Port > 65535 {
		return cfg, fmt.Errorf("port 必须在 0–65535 之间")
	}
	return cfg, Validate(cfg.Settings)
}

// Effective 在边界处应用环境变量覆盖，覆盖值只作用于本次运行，不会落盘。
func Effective(s Settings) Settings {
	if v := os.Getenv("STUDIO_LLM_PROVIDER"); v != "" {
		s.LLM.Provider = v
	}
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

// Validate 校验服务地址与模型参数范围，避免把凭据写进 URL 或使用越界参数。
func Validate(s Settings) error {
	if s.LLM.Provider != "" {
		if _, ok := LLMProviderDefaults(s.LLM.Provider); !ok {
			return fmt.Errorf("不支持的模型服务类型")
		}
	}
	if s.LLM.Provider == "ollama" {
		if _, _, err := OllamaEndpoints(s.LLM.BaseURL); err != nil {
			return err
		}
	}
	// 地址必须是有效的 HTTP(S) 基地址，且不含认证信息、查询串或片段。
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
	if s.Speech.LocalTTS != nil {
		return s.Speech.LocalTTS.Validate()
	}
	return nil
}
