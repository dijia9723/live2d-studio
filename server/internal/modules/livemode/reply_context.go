// reply_context.go 负责把事件整理成精简的回复上下文，并对观众昵称做脱敏称呼。

package livemode

import (
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

// replyContext 是提供给模型的回复素材。只包含本轮事件、少量相关历史和最近台词，
// 避免把整场弹幕都塞进提示词导致超长和高延迟。
type replyContext struct {
	Events          []replyEvent  `json:"events"`
	RelatedChat     []relatedChat `json:"related_chat,omitempty"`
	RecentHostLines []string      `json:"recent_host_lines,omitempty"`
}

// replyEvent 是发送给模型的一条事件描述，观众用 viewer_ref 编号引用而非完整身份。
type replyEvent struct {
	Kind      Kind   `json:"kind"`
	ViewerRef int    `json:"viewer_ref,omitempty"`
	Address   string `json:"address,omitempty"`
	Nickname  string `json:"nickname,omitempty"`
	Text      string `json:"text,omitempty"`
	Count     uint64 `json:"count,omitempty"`
}

// relatedChat 是同一观众更早的相关弹幕，用于补充上下文。
type relatedChat struct {
	ViewerRef int    `json:"viewer_ref"`
	Text      string `json:"text"`
}

// replyContext 构建本轮回复的上下文：为观众分配稳定编号、补充本批事件之前的
// 相关弹幕和最近两条主播台词，并对数量做上限控制。
func (run *session) replyContext(events []Event) replyContext {
	input := replyContext{Events: make([]replyEvent, 0, len(events))}
	viewerRefs := make(map[uint64]int, len(events))
	firstChat := make(map[uint64]int, len(events))
	for _, event := range events {
		ref := viewerRefs[event.viewerID]
		if event.viewerID != 0 && ref == 0 {
			ref = len(viewerRefs) + 1
			viewerRefs[event.viewerID] = ref
		}
		if ref != 0 && event.Kind == Chat && firstChat[event.viewerID] == 0 {
			firstChat[event.viewerID] = event.ID
		}
		address, nickname := viewerAddress(event.Viewer)
		input.Events = append(input.Events, replyEvent{
			Kind: event.Kind, ViewerRef: ref, Address: address, Nickname: nickname, Text: event.Text, Count: event.Count,
		})
	}

	perViewer := make(map[uint64]int, len(firstChat))
	for i := len(run.recentChats) - 1; i >= 0 && len(input.RelatedChat) < 8; i-- {
		chat := run.recentChats[i]
		if first := firstChat[chat.viewerID]; first == 0 || chat.ID >= first || perViewer[chat.viewerID] >= 2 {
			continue
		}
		input.RelatedChat = append(input.RelatedChat, relatedChat{viewerRefs[chat.viewerID], limitText(chat.Text, 160)})
		perViewer[chat.viewerID]++
	}
	slices.Reverse(input.RelatedChat)

	for i := len(run.replies) - 1; i >= 0 && len(input.RecentHostLines) < 2; i-- {
		if prior := run.replies[i]; prior.Text != "" && prior.Error == "" {
			input.RecentHostLines = append(input.RecentHostLines, limitText(prior.Text, 160))
		}
	}
	slices.Reverse(input.RecentHostLines)
	return input
}

var numericNickname = regexp.MustCompile(`(?i)^(dou)?[0-9]{2,}$`)

// viewerAddress 生成安全的观众称呼：纯数字昵称只取末两位加“哥”，
// 过长或含符号的昵称不直接展示，改为匿名引用，避免把原始账号信息带进台词。
func viewerAddress(nickname string) (address, reference string) {
	nickname = strings.TrimFunc(nickname, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsNumber(r) })
	if nickname == "稳如老狗" {
		return "老狗", ""
	}
	if numericNickname.MatchString(nickname) {
		return nickname[len(nickname)-2:] + "哥", ""
	}
	if utf8.RuneCountInString(nickname) <= 3 && strings.IndexFunc(nickname, func(r rune) bool { return !unicode.IsLetter(r) }) < 0 {
		return nickname, ""
	}
	return "", nickname
}
