// 本文件覆盖四则运算解析与内置工具的输入校验、事件推送行为。

package agent

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/cloudwego/eino/components/tool"
)

// TestCalculate 覆盖优先级、负数、括号、小数、大整数以及非法/超长表达式，
// 确认所有非法输入都返回 toolInputError。
func TestCalculate(t *testing.T) {
	for _, tc := range []struct {
		expression string
		want       string
	}{
		{"2 + 3 * 4", "14"},
		{"-(2 + 3) * 4", "-20"},
		{"8 / 4 / 2", "1"},
		{"0.1 + 0.2", "0.3"},
		{"009 + .5 - -0.5", "10"},
		{"1 / 8", "0.125"},
		{"1 / 3", "1/3（约 0.3333333333333333）"},
		{"99999999999999999999999999 + 1", "100000000000000000000000000"},
	} {
		result, err := calculate(tc.expression)
		if err != nil || result != tc.want {
			t.Errorf("calculate(%q) = %q, %v, want %q", tc.expression, result, err, tc.want)
		}
	}

	for _, expression := range []string{"", "1 / (3 - 3)", "1.0.0", "(1+2", "4 5", "2(1+2)", "2+\x00", "os.Exit(0)", strings.Repeat("1", maxCalculationBytes+1)} {
		var inputError toolInputError
		if _, err := calculate(expression); !errors.As(err, &inputError) {
			t.Errorf("calculate(%q) returned %v instead of a tool input error", expression, err)
		}
	}
}

// TestBuiltInTools 验证时区换算、RFC3339 格式与非法参数处理，
// 并确保只有合法表情才会推送一次 expression 事件。
func TestBuiltInTools(t *testing.T) {
	ctx := context.Background()
	var events []Event
	tools, err := builtInTools(func(event Event) { events = append(events, event) })
	if err != nil {
		t.Fatal(err)
	}
	byName := make(map[string]tool.InvokableTool, len(tools))
	for _, base := range tools {
		info, err := base.Info(ctx)
		if err != nil {
			t.Fatal(err)
		}
		byName[info.Name] = base.(tool.InvokableTool)
	}

	for _, tc := range []struct{ args, suffix string }{
		{`{"timezone":"Asia/Shanghai"}`, "+08:00"},
		{`{"timezone":"UTC"}`, "Z"},
	} {
		result, err := byName["current_time"].InvokableRun(ctx, tc.args)
		if err != nil || !strings.HasSuffix(result, tc.suffix) {
			t.Fatalf("current_time(%s) = %q, %v, want %q suffix", tc.args, result, err, tc.suffix)
		}
		if _, err := time.Parse(time.RFC3339, result); err != nil {
			t.Fatalf("invalid RFC3339 time: %s", result)
		}
	}
	if _, err := byName["current_time"].InvokableRun(ctx, "{}"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, args string }{
		{"current_time", `{"timezone":"Unknown/City"}`},
		{"set_expression", `{"expression":"undefined"}`},
		{"calculate", `{"expression":"1/0"}`},
	} {
		var inputError toolInputError
		if _, err := byName[tc.name].InvokableRun(ctx, tc.args); !errors.As(err, &inputError) {
			t.Errorf("%s expected input error, got %v", tc.name, err)
		}
	}
	if len(events) != 0 {
		t.Fatalf("invalid expression emitted an event: %+v", events)
	}
	if _, err := byName["set_expression"].InvokableRun(ctx, `{"expression":"happy"}`); err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Type != "expression" || events[0].Expression != "happy" {
		t.Fatalf("unexpected expression events: %+v", events)
	}
	if result, err := byName["calculate"].InvokableRun(ctx, `{"expression":"0.07 * 250"}`); err != nil || result != "17.5" {
		t.Fatalf("unexpected calculation: %q, %v", result, err)
	}
}
