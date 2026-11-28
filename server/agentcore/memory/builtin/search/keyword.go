package search

import (
	"context"
	"errors"
	"math"
	"sort"
	"strings"
	"time"
)

const (
	// 关键词覆盖度是主信号，命中数量和时间衰减作为辅助排序信号。
	keywordCoverageWeight = 0.70
	keywordCountWeight    = 0.15
	recencyWeight         = 0.15
	recencyHalfLife       = 7 * 24 * time.Hour
)

type KeywordSearcher struct {
	store KeywordStore
}

func NewKeywordSearcher(store KeywordStore) *KeywordSearcher {
	return &KeywordSearcher{store: store}
}

func (s *KeywordSearcher) Search(ctx context.Context, q *SearchQuery) ([]*SearchHit, error) {
	if s == nil || s.store == nil {
		return nil, errors.New("keyword searcher is not configured")
	}
	if q == nil {
		return nil, errors.New("search query is nil")
	}

	query := *q
	if query.Limit <= 0 {
		query.Limit = 5
	}
	limit := query.Limit
	query.Match = NormalizeMatch(query.Match)
	if len(query.Keywords) == 0 {
		query.Keywords = InferKeywords(query.Query)
	}
	if len(query.Keywords) == 0 {
		return nil, errors.New("keywords are required")
	}

	// 多取一些候选再按命中数排序，避免只按时间倒序取前 N 条导致最相关消息被挤掉。
	query.Limit = limit * 4
	if query.Limit < 20 {
		query.Limit = 20
	}
	msgs, err := s.store.SearchMessagesByKeywords(ctx, &query)
	if err != nil {
		return nil, err
	}

	keywordTotal := countKeywords(query.Keywords)
	now := time.Now()
	hits := make([]*SearchHit, 0, len(msgs))
	for _, msg := range msgs {
		text := SearchText(msg)
		matched, ok := MatchesKeywords(text, query.Keywords, query.Match)
		if !ok {
			continue
		}
		hits = append(hits, &SearchHit{
			Message: CloneMessage(msg),
			Score:   scoreKeywordHit(matched, keywordTotal, msg.CreatedAt, now),
			Snippet: buildSnippet(text, query.Keywords),
		})
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		return hits[i].Message.CreatedAt.After(hits[j].Message.CreatedAt)
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits, nil
}

func (s *KeywordSearcher) Index(context.Context, *Message) error {
	return nil
}

func (s *KeywordSearcher) Reindex(context.Context, string, string) error {
	return nil
}

func countKeywords(keywords []string) int {
	total := 0
	for _, keyword := range keywords {
		if strings.TrimSpace(keyword) != "" {
			total++
		}
	}
	return total
}

// scoreKeywordHit 综合关键词覆盖度、命中数量与时间衰减，输出 0~1 的排序分。
func scoreKeywordHit(matched, total int, createdAt, now time.Time) float64 {
	coverage := 0.0
	if total > 0 {
		coverage = math.Min(1, float64(matched)/float64(total))
	}
	countScore := math.Min(1, float64(matched)/3)
	recency := 1.0
	if !createdAt.IsZero() {
		age := now.Sub(createdAt)
		if age > 0 {
			recency = math.Pow(0.5, age.Seconds()/recencyHalfLife.Seconds())
		}
	}
	return keywordCoverageWeight*coverage + keywordCountWeight*countScore + recencyWeight*recency
}

func buildSnippet(text string, keywords []string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}

	runes := []rune(text)
	lowerRunes := []rune(strings.ToLower(text))
	start := 0
	found := false

	for _, keyword := range keywords {
		keyword = strings.TrimSpace(strings.ToLower(keyword))
		if keyword == "" {
			continue
		}
		target := []rune(keyword)
		for i := 0; i <= len(lowerRunes)-len(target); i++ {
			if string(lowerRunes[i:i+len(target)]) == string(target) {
				start = i
				found = true
				break
			}
		}
		if found {
			break
		}
	}

	if !found {
		if len(runes) <= 120 {
			return text
		}
		return string(runes[:120]) + "..."
	}

	begin := start - 40
	if begin < 0 {
		begin = 0
	}
	end := start + 80
	if end > len(runes) {
		end = len(runes)
	}

	snippet := string(runes[begin:end])
	if begin > 0 {
		snippet = "..." + snippet
	}
	if end < len(runes) {
		snippet += "..."
	}
	return snippet
}
