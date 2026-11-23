// commands_test.go 覆盖弹幕点动作的口令识别与动作匹配。

package livemode

import (
	"strings"
	"testing"

	"server/internal/modules/character"
)

func TestCommandWord(t *testing.T) {
	cases := []struct {
		text string
		want bool
	}{
		{"老狗，眨个眼", true},
		{"喵 眨一下眼", true},
		{"点头点头", true},
		{"别眨眼", false},
		{"不要摇头", false},
		{"今天眼睛有点累，眨个不停", false},
		{strings.Repeat("啊", 24) + "眨个眼", false},
		{"晚上好呀", false},
	}
	for _, item := range cases {
		_, ok := commandWord(item.text)
		if ok != item.want {
			t.Errorf("commandWord(%q) = %v, want %v", item.text, ok, item.want)
		}
	}
}

func TestMatchAction(t *testing.T) {
	actions := character.Actions{
		CharacterID: "mao", ModelPath: "/models/mao/mao.model3.json",
		Motions: []character.Motion{
			{ID: `["",0]`, Group: "", Label: "动作 · eye_biyan", DefaultLabel: "动作 · eye_biyan"},
			{ID: `["",1]`, Group: "", Label: "动作 · head_diantou", DefaultLabel: "动作 · head_diantou"},
		},
		Expressions: []character.NativeExpression{{ID: "smile", Label: "微笑", DefaultLabel: "smile"}},
	}
	rule, ok := commandWord("眨个眼")
	if !ok {
		t.Fatal("眨个眼 was not recognized as a command")
	}
	action, label, ok := matchAction(actions, rule.Names)
	if !ok || action.ID != `["",0]` || action.Type != "motion" || label != "动作 · eye_biyan" {
		t.Fatalf("unexpected blink match %+v, %q, %v", action, label, ok)
	}
	// 自定义中文动作名同样可以命中。
	actions.Motions[1].Label = "点头"
	action, label, ok = matchAction(actions, commandRules[1].Names)
	if !ok || action.ID != `["",1]` || label != "点头" {
		t.Fatalf("unexpected renamed motion match %+v, %q, %v", action, label, ok)
	}
	// 没有动作时回退到原生表情。
	action, _, ok = matchAction(actions, []string{"微笑"})
	if !ok || action.Type != "expression" || action.ID != "smile" {
		t.Fatalf("unexpected expression fallback %+v, %v", action, ok)
	}
	if _, _, ok = matchAction(actions, []string{"不存在"}); ok {
		t.Fatal("missing action should not match")
	}
}
