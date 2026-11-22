// 本文件将应用配置适配为 agentcore 使用的 AgenticModel。

package agent

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/cloudwego/eino-ext/components/model/agenticopenai"
	"github.com/cloudwego/eino/schema"
	"server/internal/config"
)

func CompleteText(ctx context.Context, cfg config.LLM, instruction, input string) (string, error) {
	key := strings.TrimSpace(cfg.APIKey)
	if key == "" {
		if cfg.Provider != "ollama" && cfg.Provider != "lmstudio" {
			return "", errors.New("请先配置语言模型服务")
		}
		key = "local"
	}
	client, err := newAgenticChatModel(ctx, cfg, key)
	if err != nil {
		return "", err
	}
	reply, err := client.Generate(ctx, []*schema.AgenticMessage{
		{Role: schema.AgenticRoleTypeSystem, ContentBlocks: []*schema.ContentBlock{
			schema.NewContentBlock(&schema.UserInputText{Text: instruction}),
		}},
		schema.UserAgenticMessage(input),
	})
	if err != nil {
		return "", err
	}
	if reply == nil {
		return "", errors.New("模型未返回内容")
	}
	var result strings.Builder
	forwardAssistantText(reply, func(event Event) { result.WriteString(event.Text) })
	text := strings.TrimSpace(result.String())
	if text == "" {
		return "", errors.New("模型未返回内容")
	}
	return text, nil
}

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
