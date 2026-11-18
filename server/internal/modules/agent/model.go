// 本文件将应用配置适配为 agentcore 使用的 AgenticModel。

package agent

import (
	"context"
	"strings"
	"time"

	"github.com/cloudwego/eino-ext/components/model/agenticopenai"
	"server/internal/config"
)

func newAgenticChatModel(ctx context.Context, cfg config.LLM, key string) (*agenticopenai.ChatModel, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if cfg.Provider == "ollama" {
		_, compatibleURL, err := config.OllamaEndpoints(baseURL)
		if err != nil {
			return nil, err
		}
		baseURL = compatibleURL
		// Ollama 本地接口不需要云端凭据；切换服务时不转发之前保存的密钥。
		key = "ollama"
	}
	modelName := strings.TrimSpace(cfg.Model)
	modelConfig := &agenticopenai.ChatConfig{
		APIKey:  key,
		BaseURL: baseURL,
		Model:   modelName,
		Timeout: 2 * time.Minute,
	}
	name := strings.ToLower(modelName)
	if cfg.Provider != "ollama" && (strings.HasPrefix(name, "gpt-5") || strings.HasPrefix(name, "o1") || strings.HasPrefix(name, "o3") || strings.HasPrefix(name, "o4")) {
		modelConfig.MaxCompletionTokens = &cfg.MaxTokens
	} else {
		modelConfig.Temperature = &cfg.Temperature
		// 保留 max_tokens，兼容不接受 max_completion_tokens 的服务。
		modelConfig.ExtraFields = map[string]any{"max_tokens": cfg.MaxTokens}
	}
	return agenticopenai.NewChatModel(ctx, modelConfig)
}
