package agent

import (
	"strings"
	"time"

	"github.com/cloudwego/eino-ext/components/model/openai"
	"server/internal/config"
)

// The adapter validates these model families before sending the HTTP request.
// Sending temperature for them makes an otherwise valid configuration fail
// locally, even when a parameter-free connection check succeeds.
func chatModelConfig(cfg config.LLM, key string) *openai.ChatModelConfig {
	model := strings.TrimSpace(cfg.Model)
	c := &openai.ChatModelConfig{
		BaseURL: strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/"),
		APIKey:  strings.TrimSpace(key), Model: model, Timeout: 2 * time.Minute,
	}
	name := strings.ToLower(model)
	if strings.HasPrefix(name, "gpt-5") || strings.HasPrefix(name, "o1") || strings.HasPrefix(name, "o3") || strings.HasPrefix(name, "o4") {
		c.MaxCompletionTokens = &cfg.MaxTokens
	} else {
		c.Temperature = &cfg.Temperature
		c.MaxTokens = &cfg.MaxTokens
	}
	return c
}
