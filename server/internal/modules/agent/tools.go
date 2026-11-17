// 本文件注册 agent 的内置工具，并向模型声明参数与错误语义。

package agent

import (
	"context"
	"strings"
	"time"
	_ "time/tzdata" // 在缺少系统时区数据库的环境（如精简 Windows）中提供 IANA 时区。

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
)

// toolInputError 携带可直接回传给模型的固定提示。
// 只有这类错误会把原文暴露给模型，因此文案中不得包含内部路径或上游错误细节。
type toolInputError string

func (e toolInputError) Error() string { return string(e) }

// builtInTools 构造 current_time、set_expression 与 calculate 三个工具。
// set_expression 仅在参数为合法枚举时推送表情事件，保证界面不会收到未知表情。
func builtInTools(emit func(Event)) ([]tool.BaseTool, error) {
	clock, err := utils.InferTool("current_time", "获取指定时区的当前日期和时间（RFC3339）。省略时区时返回服务端本地时间。", currentTime)
	if err != nil {
		return nil, err
	}
	expression, err := utils.InferTool("set_expression", "切换当前 Live2D 角色的表情。", func(_ context.Context, in struct {
		Expression string `json:"expression" jsonschema:"description=表情名称,enum=neutral,enum=happy,enum=sad,enum=surprised"`
	}) (string, error) {
		switch in.Expression {
		case "neutral", "happy", "sad", "surprised":
			emit(Event{Type: "expression", Expression: in.Expression})
			return "表情已更新", nil
		default:
			return "", toolInputError("请选择 neutral、happy、sad 或 surprised 表情。")
		}
	})
	if err != nil {
		return nil, err
	}
	calculator, err := utils.InferTool("calculate", "计算整数和小数表达式，支持括号和 + - * /。结果无法写成有限小数时同时提供精确分数和近似值。", func(_ context.Context, in struct {
		Expression string `json:"expression" jsonschema:"description=使用半角数字和运算符的数学表达式，最多 256 个字符。例如 (12.5 + 7.5) / 3"`
	}) (string, error) {
		return calculate(in.Expression)
	})
	if err != nil {
		return nil, err
	}
	return []tool.BaseTool{clock, expression, calculator}, nil
}

type currentTimeInput struct {
	Timezone string `json:"timezone,omitempty" jsonschema:"description=IANA 时区名称，例如 Asia/Shanghai 或 UTC。省略时使用服务端本地时区"`
}

// currentTime 返回指定 IANA 时区的 RFC3339 时间，时区为空时使用服务端本地时区。
// 时区名过长或无法加载时返回统一的输入错误，避免向模型泄露时区数据库细节。
func currentTime(_ context.Context, in currentTimeInput) (string, error) {
	zone := strings.TrimSpace(in.Timezone)
	if zone == "" {
		return time.Now().Format(time.RFC3339), nil
	}
	const invalidTimezone = toolInputError("请输入有效的 IANA 时区，例如 Asia/Shanghai 或 UTC。")
	if len(zone) > 100 {
		return "", invalidTimezone
	}
	location, err := time.LoadLocation(zone)
	if err != nil {
		return "", invalidTimezone
	}
	return time.Now().In(location).Format(time.RFC3339), nil
}
