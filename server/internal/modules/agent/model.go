// 本文件根据模型名称组装 OpenAI 兼容的模型参数。

package agent

import (
	"strings"
	"time"

	"github.com/cloudwego/eino-ext/components/model/openai"
	"server/internal/config"
)

// chatModelConfig 组装聊天模型配置。
// gpt-5、o1、o3、o4 等系列不接受 temperature 与 max_tokens，适配层会在本地直接拒绝
// 这些参数，因此只对它们设置 MaxCompletionTokens；其它模型才使用 Temperature 与 MaxTokens，
// 否则一个本来可用的配置会在发起请求时本地失败。
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
