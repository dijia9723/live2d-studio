package agent

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/cloudwego/eino-ext/components/model/openai"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/flow/agent/react"
	"github.com/cloudwego/eino/schema"
	"server/internal/config"
	"server/internal/model"
)

type Event struct {
	Type       string `json:"type"`
	Text       string `json:"text,omitempty"`
	Expression string `json:"expression,omitempty"`
}
type Streamer interface {
	Stream(context.Context, config.LLM, model.Character, []model.Message, func(Event)) error
}
type Service struct{}

func (s *Service) Stream(ctx context.Context, cfg config.LLM, character model.Character, history []model.Message, emit func(Event)) error {
	key := strings.TrimSpace(cfg.APIKey)
	if key == "" {
		key = "local"
	}
	cm, err := openai.NewChatModel(ctx, chatModelConfig(cfg, key))
	if err != nil {
		return err
	}
	prompt := character.SystemPrompt + "\n你是一个 Live2D 伙伴。回答自然、简短。不要假装自己完成了没有执行的操作。"
	msgs := []*schema.Message{schema.SystemMessage(prompt)}
	for _, m := range history {
		msg := &schema.Message{Role: schema.RoleType(m.Role), Content: m.Content}
		if m.Image != "" {
			msg.Content = ""
			msg.MultiContent = []schema.ChatMessagePart{{Type: schema.ChatMessagePartTypeText, Text: m.Content}, {Type: schema.ChatMessagePartTypeImageURL, ImageURL: &schema.ChatMessageImageURL{URL: m.Image}}}
		}
		msgs = append(msgs, msg)
	}
	var stream *schema.StreamReader[*schema.Message]
	if cfg.ToolsEnabled {
		clock, toolErr := utils.InferTool("current_time", "获取当前时间", func(ctx context.Context, in struct{}) (string, error) { return time.Now().Format(time.RFC3339), nil })
		if toolErr != nil {
			return toolErr
		}
		expression, toolErr := utils.InferTool("set_expression", "切换角色表情：neutral、happy、sad、surprised", func(ctx context.Context, in struct {
			Expression string `json:"expression" jsonschema:"description=表情名称"`
		}) (string, error) {
			if in.Expression != "neutral" && in.Expression != "happy" && in.Expression != "sad" && in.Expression != "surprised" {
				return "无效的表情", nil
			}
			emit(Event{Type: "expression", Expression: in.Expression})
			return "表情已更新", nil
		})
		if toolErr != nil {
			return toolErr
		}
		a, agentErr := react.NewAgent(ctx, &react.AgentConfig{ToolCallingModel: cm, ToolsConfig: compose.ToolsNodeConfig{Tools: []tool.BaseTool{clock, expression}}, MaxStep: 10})
		if agentErr != nil {
			return agentErr
		}
		stream, err = a.Stream(ctx, msgs)
	} else {
		chain := compose.NewChain[[]*schema.Message, *schema.Message]().AppendChatModel(cm)
		runnable, compileErr := chain.Compile(ctx)
		if compileErr != nil {
			return compileErr
		}
		stream, err = runnable.Stream(ctx, msgs)
	}
	if err != nil {
		return err
	}
	defer stream.Close()
	for {
		chunk, recvErr := stream.Recv()
		if recvErr == io.EOF {
			return nil
		}
		if recvErr != nil {
			return fmt.Errorf("模型流读取失败: %w", recvErr)
		}
		if chunk.Content != "" {
			emit(Event{Type: "delta", Text: chunk.Content})
		}
	}
}
