// 本文件用 Eino 中间件观察工具调用，并把工具错误转换为结构化结果回传给模型。

package agent

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/cloudwego/eino/compose"
	"github.com/google/uuid"
	"server/internal/model"
	"server/internal/modules/memory"
)

// observeToolRun 包装工具调用，向界面推送 running/completed/failed 状态。
// 工具执行出错时转换为结构化结果回传模型而不是中断整轮对话；
// 但上游 ctx 已取消时必须原样返回 ctx 错误，让对话层把回复标记为 interrupted。
func observeToolRun(emit func(Event)) compose.InvokableToolMiddleware {
	return func(next compose.InvokableToolEndpoint) compose.InvokableToolEndpoint {
		return func(ctx context.Context, input *compose.ToolInput) (*compose.ToolOutput, error) {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			id := uuid.NewString()
			emitToolRun(emit, id, input.Name, model.ToolRunning)
			output, err := next(ctx, input)
			if err == nil {
				emitToolRun(emit, id, input.Name, model.ToolCompleted)
				return output, nil
			}
			emitToolRun(emit, id, input.Name, model.ToolFailed)
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			message := "工具调用失败。请检查参数，或说明该工具暂不可用。"
			var inputErr toolInputError
			switch {
			case errors.As(err, &inputErr):
				message = inputErr.Error()
			case errors.Is(err, memory.ErrSearchQuery):
				message = memory.ErrSearchQuery.Error()
			}
			return &compose.ToolOutput{Result: toolErrorResult(message)}, nil
		}
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
