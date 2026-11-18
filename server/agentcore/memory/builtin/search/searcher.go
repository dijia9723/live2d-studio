package search

import (
	"context"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/cloudwego/eino/schema"
)

type SearchMode string

const (
	ModeKeyword SearchMode = "keyword"
	ModeVector  SearchMode = "vector"
	ModeHybrid  SearchMode = "hybrid"
)

const (
	MatchAny = "any"
	MatchAll = "all"
)

const (
	HybridStrategyRRF      = "rrf"
	HybridStrategyWeighted = "weighted"
)

type Message struct {
	ID        string
	SessionID string
	UserID    string
	Role      string
	Content   string
	Parts     []schema.MessageInputPart
	CreatedAt time.Time
}

type SearchQuery struct {
	SessionID string
	UserID    string

	Since *time.Time
	Until *time.Time
	Role  string
	Limit int

	Keywords []string
	Match    string

	Query string
}

type SearchHit struct {
	Message *Message
	Score   float64
	Snippet string
}

type Searcher interface {
	Search(ctx context.Context, q *SearchQuery) ([]*SearchHit, error)
	Index(ctx context.Context, msg *Message) error
	Reindex(ctx context.Context, sessionID, userID string) error
}

type MessageSource interface {
	ListMessages(ctx context.Context, sessionID, userID string) ([]*Message, error)
}

type KeywordStore interface {
	MessageSource
	SearchMessagesByKeywords(ctx context.Context, q *SearchQuery) ([]*Message, error)
}

type VectorStore interface {
	Upsert(ctx context.Context, msg *Message, vector []float64) error
	Search(ctx context.Context, q *SearchQuery, vector []float64, limit int) ([]*SearchHit, error)
}

type HybridConfig struct {
	Strategy string
	RRFK     int
	Weights  HybridWeights
}

type HybridWeights struct {
	Keyword float64
	Vector  float64
}

func CloneMessage(msg *Message) *Message {
	if msg == nil {
		return nil
	}
	cloned := *msg
	if len(msg.Parts) > 0 {
		cloned.Parts = append([]schema.MessageInputPart(nil), msg.Parts...)
	}
	return &cloned
}

func NormalizeMatch(match string) string {
	match = strings.TrimSpace(strings.ToLower(match))
	if match == MatchAll {
		return MatchAll
	}
	return MatchAny
}

var keywordSplitter = strings.NewReplacer(
	"\n", " ", "\t", " ", "\r", " ",
	"，", " ", "。", " ", "、", " ", "；", " ", ";", " ", ",", " ", "|", " ",
	"？", " ", "?", " ", "！", " ", "!", " ", "：", " ", ":", " ",
	"（", " ", "）", " ", "(", " ", ")", " ", "【", " ", "】", " ", "[", " ", "]", " ",
	"《", " ", "》", " ", "“", " ", "”", " ", "‘", " ", "’", " ", "\"", " ",
	"…", " ", "—", " ", "/", " ", "\\", " ",
)

// cjkStopwords 是没有分词器时对中文问句做粗切分的停用词；
// 按长度降序匹配，避免短词先拆坏长词（如“为什么”被“什么”拆开）。
var cjkStopwords = []string{
	"为什么", "什么样", "怎么样", "什么", "怎么", "怎样", "如何", "为何", "是否",
	"请问", "麻烦", "帮我", "帮忙", "介绍", "告诉", "一下", "我们", "你们", "他们",
	"这个", "那个", "哪个", "哪些", "这里", "那里", "可以", "能否", "需要", "现在",
	"之前", "关于", "以及", "还有", "但是", "因为", "所以", "然后", "如果",
}

// cjkParticles 是中文里几乎只作连接/语气用法的单字，作为切分边界。
var cjkParticles = []string{"的", "地", "得", "了", "吗", "呢", "吧", "啊", "呀", "嘛"}

const (
	// cjkBigramMinRunes 超过该长度的中文片段仍像整句，拆成二元组提升召回。
	cjkBigramMinRunes = 3
	maxInferredKeywords = 16
)

func InferKeywords(text string) []string {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}

	fields := strings.Fields(keywordSplitter.Replace(text))
	if len(fields) == 0 {
		fields = []string{text}
	}

	seen := make(map[string]struct{}, len(fields))
	out := make([]string, 0, len(fields))
	appendKeyword := func(field string) {
		field = strings.TrimSpace(field)
		if field == "" || len(out) >= maxInferredKeywords {
			return
		}
		if _, ok := seen[field]; ok {
			return
		}
		seen[field] = struct{}{}
		out = append(out, field)
	}

	for _, field := range fields {
		for _, part := range splitCJKField(field) {
			appendKeyword(part)
		}
	}
	if len(out) == 0 {
		return []string{text}
	}
	return out
}

// splitCJKField 把单个中文片段切成更可能出现在历史消息里的关键词：
// 去掉问句停用词、按语气字切开，过长的片段再拆成二元组。
func splitCJKField(field string) []string {
	if !containsHan(field) {
		return []string{field}
	}

	cleaned := field
	for _, word := range cjkStopwords {
		cleaned = strings.ReplaceAll(cleaned, word, " ")
	}
	for _, particle := range cjkParticles {
		cleaned = strings.ReplaceAll(cleaned, particle, " ")
	}

	kept := make([]string, 0, 8)
	for _, part := range strings.Fields(cleaned) {
		// 中英文混排（如“API接口”）按字符类型分段，避免把英文一起拆成二元组。
		for _, run := range splitScriptRuns(part) {
			if !run.han {
				kept = append(kept, run.text)
				continue
			}
			switch runes := utf8.RuneCountInString(run.text); {
			case runes < 2:
				// 单字过于宽泛，直接丢弃。
			case runes >= cjkBigramMinRunes:
				kept = append(kept, bigrams(run.text)...)
			default:
				kept = append(kept, run.text)
			}
		}
	}
	if len(kept) == 0 {
		return []string{field}
	}
	return kept
}

type scriptRun struct {
	text string
	han  bool
}

func splitScriptRuns(text string) []scriptRun {
	runs := make([]scriptRun, 0, 2)
	var current []rune
	currentHan := false
	flush := func() {
		if len(current) == 0 {
			return
		}
		runs = append(runs, scriptRun{text: string(current), han: currentHan})
		current = current[:0]
	}
	for _, r := range text {
		han := unicode.Is(unicode.Han, r)
		if len(current) > 0 && han != currentHan {
			flush()
		}
		currentHan = han
		current = append(current, r)
	}
	flush()
	return runs
}

func bigrams(text string) []string {
	runes := []rune(text)
	if len(runes) < 2 {
		return nil
	}
	out := make([]string, 0, len(runes)-1)
	for i := 0; i+1 < len(runes); i++ {
		out = append(out, string(runes[i:i+2]))
	}
	return out
}

func containsHan(text string) bool {
	for _, r := range text {
		if unicode.Is(unicode.Han, r) {
			return true
		}
	}
	return false
}

func SearchText(msg *Message) string {
	if msg == nil {
		return ""
	}
	if strings.TrimSpace(msg.Content) != "" {
		return strings.TrimSpace(msg.Content)
	}

	texts := make([]string, 0, len(msg.Parts))
	for _, part := range msg.Parts {
		if part.Type == schema.ChatMessagePartTypeText && strings.TrimSpace(part.Text) != "" {
			texts = append(texts, strings.TrimSpace(part.Text))
		}
	}
	return strings.Join(texts, "\n")
}

func MatchesKeywords(text string, keywords []string, match string) (int, bool) {
	text = strings.ToLower(strings.TrimSpace(text))
	if text == "" {
		return 0, false
	}

	filtered := make([]string, 0, len(keywords))
	for _, keyword := range keywords {
		keyword = strings.ToLower(strings.TrimSpace(keyword))
		if keyword != "" {
			filtered = append(filtered, keyword)
		}
	}
	if len(filtered) == 0 {
		return 0, false
	}

	matched := 0
	for _, keyword := range filtered {
		if strings.Contains(text, keyword) {
			matched++
			continue
		}
		if NormalizeMatch(match) == MatchAll {
			return matched, false
		}
	}

	if NormalizeMatch(match) == MatchAll {
		return matched, matched == len(filtered)
	}
	return matched, matched > 0
}
