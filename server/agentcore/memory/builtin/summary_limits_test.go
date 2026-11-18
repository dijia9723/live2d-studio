package builtin

import (
	"strings"
	"testing"
)

func TestLimitSummaryContextTruncatesOlderMessages(t *testing.T) {
	messages := []*ConversationMessage{
		{Role: "user", Content: "最早消息-" + strings.Repeat("旧", 80)},
		{Role: "assistant", Content: "中间消息-" + strings.Repeat("中", 80)},
		{Role: "user", Content: "最新消息-" + strings.Repeat("新", 80)},
	}

	_, history := limitSummaryContext("", messages, 120)
	if got := len([]rune(history)); got > 120 {
		t.Fatalf("history runes = %d, want <= 120", got)
	}
	if !strings.Contains(history, "最新消息") {
		t.Fatalf("history should keep the latest message: %q", history)
	}
	if strings.Contains(history, "最早消息") {
		t.Fatalf("history should drop the oldest message: %q", history)
	}
	if !strings.Contains(history, strings.TrimSpace(summaryTruncatedMarker)) {
		t.Fatalf("history should contain truncation marker: %q", history)
	}
}

func TestLimitSummaryContextReservesHalfBudgetForSummary(t *testing.T) {
	existing := strings.Repeat("摘要", 100)
	trimmed, history := limitSummaryContext(existing, []*ConversationMessage{
		{Role: "user", Content: strings.Repeat("新", 200)},
	}, 100)

	if got := len([]rune(trimmed)); got > 50 {
		t.Fatalf("existing summary runes = %d, want <= 50", got)
	}
	if got := len([]rune(history)); got > 50 {
		t.Fatalf("history runes = %d, want <= 50", got)
	}
}

func TestTrimSummaryOutputHardTruncates(t *testing.T) {
	generator := &SessionSummaryGenerator{}
	output := strings.Repeat("答", defaultSummaryOutputMaxRunes+200)

	got := generator.trimSummaryOutput(output)
	if runes := len([]rune(got)); runes != defaultSummaryOutputMaxRunes {
		t.Fatalf("output runes = %d, want %d", runes, defaultSummaryOutputMaxRunes)
	}
}
