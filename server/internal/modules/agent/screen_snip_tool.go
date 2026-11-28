package agent

import (
	"context"
	"strings"
	"sync/atomic"
	"unicode/utf8"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
)

type screenSnipClientKey struct{}

// WithScreenSnipRequests indicates that the conversation client can show a screenshot request.
func WithScreenSnipRequests(ctx context.Context) context.Context {
	return context.WithValue(ctx, screenSnipClientKey{}, true)
}

func screenSnipRequestsEnabled(ctx context.Context) bool {
	enabled, _ := ctx.Value(screenSnipClientKey{}).(bool)
	return enabled
}

func requestScreenSnipTool(emit func(Event)) (tool.BaseTool, error) {
	var requested atomic.Bool
	return utils.InferTool(
		"request_screen_snip",
		"请用户手动框选 Windows 屏幕并发送截图。仅在用户询问屏幕内容、要求截图或完成当前视觉任务确实需要时使用。调用不会截取屏幕，也不会返回图像。",
		func(_ context.Context, input struct {
			Reason string `json:"reason" jsonschema:"description=向用户简要说明需要查看哪一部分屏幕及用途"`
		}) (string, error) {
			reason := strings.TrimSpace(input.Reason)
			if reason == "" || utf8.RuneCountInString(reason) > 200 {
				return "", toolInputError("请提供 1–200 个字符的截图用途。")
			}
			if requested.CompareAndSwap(false, true) {
				emit(Event{Type: "screen_snip_request", Text: reason})
			}
			return "已在对话中提示用户框选屏幕。请等待用户发送包含截图的新消息，当前未获取画面。", nil
		},
	)
}
