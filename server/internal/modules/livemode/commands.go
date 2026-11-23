// commands.go 把弹幕里的动作口令解析成模型动作，让观众可以用弹幕点播角色动作。

package livemode

import (
	"context"
	"strings"
	"unicode/utf8"

	"server/internal/modules/agent"
	"server/internal/modules/character"
)

// commandRule 是一条弹幕口令：Words 在弹幕中出现即视为点播，
// Names 按优先级匹配模型动作的名称特征（label、default_label 或动作组）。
type commandRule struct {
	Words []string
	Names []string
}

var commandRules = []commandRule{
	{[]string{"眨眼", "眨个眼", "眨一下眼", "眨眨眼", "闭眼"}, []string{"eye_biyan", "眨眼", "闭眼", "blink"}},
	{[]string{"点头", "点个头", "点一下头"}, []string{"diantou", "点头", "nod"}},
	{[]string{"摇头", "摇个头", "摇一下头"}, []string{"yaotou", "摇头"}},
	{[]string{"歪头", "歪个头", "歪一下头"}, []string{"waitou", "歪头"}},
	{[]string{"低头", "低个头"}, []string{"ditou", "低头"}},
	{[]string{"挥手", "挥个手", "招手", "招个手"}, []string{"huishou", "挥手", "招手", "wave"}},
	{[]string{"比心", "比个心"}, []string{"bixin", "比心", "heart"}},
	{[]string{"转圈", "转个圈", "转一圈", "转个身"}, []string{"zhuan", "转"}},
	{[]string{"笑一个", "笑一下", "笑一笑", "笑个"}, []string{"face_daxiao", "face_weixiao", "face_xiao", "笑", "smile"}},
	{[]string{"生气", "生个气", "气一个"}, []string{"face_daqi", "face_shengqi", "生气", "angry"}},
	{[]string{"害羞", "害个羞", "脸红"}, []string{"lianhong", "haixiu", "害羞", "shy"}},
	{[]string{"哭一个", "哭一下", "哭个"}, []string{"face_kuqi", "kuqi", "哭", "cry"}},
	{[]string{"惊讶", "吃惊", "惊一个"}, []string{"face_xianqi", "jingya", "惊讶", "吃惊", "surprised"}},
	{[]string{"鞠躬", "鞠个躬"}, []string{"jugong", "鞠躬", "bow"}},
	{[]string{"鼓掌", "鼓个掌", "拍手"}, []string{"guzhang", "鼓掌", "clap"}},
	{[]string{"难过", "委屈", "失落", "伤心"}, []string{"face_nor_sad", "jusang", "难过", "委屈", "失落", "sad"}},
	{[]string{"兴奋", "激动"}, []string{"xingfen", "兴奋", "excited"}},
	{[]string{"疑惑", "问号"}, []string{"face_yiwen", "yiwen", "疑惑", "confused"}},
}

// commandWord 判断一条弹幕是不是在点动作：否定句和过长的聊天不当作指令，
// 避免观众随口聊天时角色乱动。
func commandWord(text string) (commandRule, bool) {
	text = strings.TrimSpace(text)
	if text == "" || utf8.RuneCountInString(text) > 24 {
		return commandRule{}, false
	}
	for _, word := range []string{"别", "不要", "不用", "不想", "不许"} {
		if strings.Contains(text, word) {
			return commandRule{}, false
		}
	}
	for _, rule := range commandRules {
		for _, word := range rule.Words {
			if strings.Contains(text, word) {
				return rule, true
			}
		}
	}
	return commandRule{}, false
}

// matchAction 按名称优先级从模型动作里找出第一个可用项，动作找不到时再试原生表情。
func matchAction(actions character.Actions, names []string) (agent.StageAction, string, bool) {
	stage := func(kind, id string) agent.StageAction {
		return agent.StageAction{CharacterID: actions.CharacterID, ModelPath: actions.ModelPath, Type: kind, ID: id}
	}
	for _, name := range names {
		name = strings.ToLower(name)
		for _, motion := range actions.Motions {
			if strings.Contains(strings.ToLower(motion.Label+" "+motion.DefaultLabel+" "+motion.Group), name) {
				return stage("motion", motion.ID), motion.Label, true
			}
		}
		for _, expression := range actions.Expressions {
			if strings.Contains(strings.ToLower(expression.Label+" "+expression.DefaultLabel), name) {
				return stage("expression", expression.ID), expression.Label, true
			}
		}
	}
	return agent.StageAction{}, "", false
}

// commandAction 从本轮弹幕里找出一个可执行的点播动作。每条回复最多自动播放一个，
// 避免同轮多个口令互相打断；没有对应动作时返回 false，交给模型口头回应。
func (s *Service) commandAction(ctx context.Context, run *session, events []Event) (agent.StageAction, string, bool) {
	if s.roles == nil || run.character.ID == "" {
		return agent.StageAction{}, "", false
	}
	for _, event := range events {
		if event.Kind != Chat {
			continue
		}
		rule, ok := commandWord(event.Text)
		if !ok {
			continue
		}
		actions, err := s.roles.Actions(ctx, run.character.ID)
		if err != nil {
			return agent.StageAction{}, "", false
		}
		return matchAction(actions, rule.Names)
	}
	return agent.StageAction{}, "", false
}
