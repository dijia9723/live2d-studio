package livemode

import (
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

type replyContext struct {
	Events          []replyEvent  `json:"events"`
	RelatedChat     []relatedChat `json:"related_chat,omitempty"`
	RecentHostLines []string      `json:"recent_host_lines,omitempty"`
}

type replyEvent struct {
	Kind      Kind   `json:"kind"`
	ViewerRef int    `json:"viewer_ref,omitempty"`
	Address   string `json:"address,omitempty"`
	Nickname  string `json:"nickname,omitempty"`
	Text      string `json:"text,omitempty"`
	Count     uint64 `json:"count,omitempty"`
}

type relatedChat struct {
	ViewerRef int    `json:"viewer_ref"`
	Text      string `json:"text"`
}

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
