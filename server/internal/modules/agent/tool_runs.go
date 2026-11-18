// 本文件用 Eino 中间件观察工具调用，并把工具错误转换为结构化结果回传给模型。

package agent

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/schema"
	"github.com/google/uuid"
	"server/internal/model"
	"server/internal/modules/character"
	"server/internal/modules/memory"
)

// toolRunMiddleware 推送工具状态；普通错误脱敏后回传模型，允许继续回复。
type toolRunMiddleware struct {
	*adk.TypedBaseChatModelAgentMiddleware[*schema.AgenticMessage]
	emit func(Event)
}

func (m *toolRunMiddleware) WrapInvokableToolCall(_ context.Context, next adk.InvokableToolCallEndpoint, toolCtx *adk.ToolContext) (adk.InvokableToolCallEndpoint, error) {
	name := "unknown_tool"
	id := uuid.NewString()
	if toolCtx != nil {
		if toolCtx.Name != "" {
			name = toolCtx.Name
		}
	}
	// 上游可能在不同迭代中复用 CallID；界面状态使用独立 ID，避免覆盖前次调用。
	return func(ctx context.Context, arguments string, opts ...tool.Option) (string, error) {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		emitToolRun(m.emit, id, name, model.ToolRunning)
		result, err := next(ctx, arguments, opts...)
		if err == nil {
			emitToolRun(m.emit, id, name, model.ToolCompleted)
			return result, nil
		}
		emitToolRun(m.emit, id, name, model.ToolFailed)
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return toolErrorResult(safeToolError(err)), nil
	}, nil
}

func safeToolError(err error) string {
	var inputErr toolInputError
	switch {
	case errors.As(err, &inputErr):
		return inputErr.Error()
	case errors.Is(err, character.ErrProfile):
		return character.ErrProfile.Error()
	case errors.Is(err, character.ErrActions):
		return character.ErrActions.Error()
	case errors.Is(err, memory.ErrSearchQuery):
		return memory.ErrSearchQuery.Error()
	case errors.Is(err, memory.ErrContent):
		return memory.ErrContent.Error()
	case errors.Is(err, memory.ErrLimit):
		return memory.ErrLimit.Error()
	default:
		return "工具调用失败。请检查参数，或说明该工具暂不可用。"
	}
}

// unknownTool 处理模型请求了未注册工具的情况：只上报失败状态并提示模型使用现有工具。
func unknownTool(emit func(Event)) func(context.Context, string, string) (string, error) {
	return func(ctx context.Context, _, _ string) (string, error) {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		emitToolRun(emit, uuid.NewString(), "unknown_tool", model.ToolFailed)
		return toolErrorResult("该工具不可用，请使用当前提供的工具。"), nil
	}
}

func emitToolRun(emit func(Event), id, name, status string) {
	emit(Event{Type: "tool", Tool: &model.ToolRun{ID: id, Name: name, Status: status}})
}

// toolErrorResult 把提示编码为 {"error": ...}，符合 Eino 工具结果约定，便于模型解析。
func toolErrorResult(message string) string {
	result, _ := json.Marshal(map[string]string{"error": message})
	return string(result)
}
