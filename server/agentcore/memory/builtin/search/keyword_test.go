package search

import (
	"context"
	"testing"
	"time"
)

type fakeKeywordStore struct {
	messages []*Message
}

func (s *fakeKeywordStore) SearchMessagesByKeywords(_ context.Context, q *SearchQuery) ([]*Message, error) {
	out := make([]*Message, 0, len(s.messages))
	for _, msg := range s.messages {
		if _, ok := MatchesKeywords(SearchText(msg), q.Keywords, q.Match); ok {
			out = append(out, msg)
		}
	}
	return out, nil
}

func (s *fakeKeywordStore) ListMessages(context.Context, string, string) ([]*Message, error) {
	return s.messages, nil
}

func hasKeyword(keywords []string, want string) bool {
	for _, keyword := range keywords {
		if keyword == want {
			return true
		}
	}
	return false
}

func TestInferKeywordsSplitsChineseQuestion(t *testing.T) {
	keywords := InferKeywords("上次讨论的部署方案是什么？")
	for _, want := range []string{"讨论", "部署", "方案"} {
		if !hasKeyword(keywords, want) {
			t.Fatalf("keywords = %v, want to contain %q", keywords, want)
		}
	}
	// 整句不应再作为一个关键词（否则 LIKE 匹配几乎不可能命中）。
	if hasKeyword(keywords, "上次讨论的部署方案是什么？") {
		t.Fatalf("keywords should not keep the whole sentence: %v", keywords)
	}
}

func TestInferKeywordsKeepsMixedScriptTokens(t *testing.T) {
	keywords := InferKeywords("API接口报错了怎么办？")
	for _, want := range []string{"API", "接口", "报错"} {
		if !hasKeyword(keywords, want) {
			t.Fatalf("keywords = %v, want to contain %q", keywords, want)
		}
	}
}

func TestInferKeywordsKeepsLatinKeywords(t *testing.T) {
	keywords := InferKeywords("login error 500")
	for _, want := range []string{"login", "error", "500"} {
		if !hasKeyword(keywords, want) {
			t.Fatalf("keywords = %v, want to contain %q", keywords, want)
		}
	}
}

func TestKeywordSearcherSearchBuildsSnippetAndScore(t *testing.T) {
	now := time.Now()
	searcher := NewKeywordSearcher(&fakeKeywordStore{
		messages: []*Message{
			{
				ID:        "m1",
				SessionID: "s1",
				UserID:    "u1",
				Role:      "user",
				Content:   "用户反馈登录接口报错 500，需要排查日志。",
				CreatedAt: now,
			},
			{
				ID:        "m2",
				SessionID: "s1",
				UserID:    "u1",
				Role:      "assistant",
				Content:   "我们已经修复了支付超时问题。",
				CreatedAt: now.Add(-time.Minute),
			},
		},
	})

	hits, err := searcher.Search(context.Background(), &SearchQuery{
		SessionID: "s1",
		UserID:    "u1",
		Keywords:  []string{"登录", "报错"},
		Match:     MatchAll,
	})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 1 {
		t.Fatalf("len(hits) = %d, want 1", len(hits))
	}
	if hits[0].Message.ID != "m1" {
		t.Fatalf("unexpected hit id: %s", hits[0].Message.ID)
	}
	if hits[0].Score < 0.9 || hits[0].Score > 1 {
		t.Fatalf("score = %v, want in (0.9, 1]", hits[0].Score)
	}
	if hits[0].Snippet == "" {
		t.Fatalf("snippet should not be empty")
	}
}

func TestKeywordSearcherRanksByCoverageAndRecency(t *testing.T) {
	now := time.Now()
	searcher := NewKeywordSearcher(&fakeKeywordStore{
		messages: []*Message{
			{
				ID:        "high-old",
				SessionID: "s1",
				UserID:    "u1",
				Role:      "user",
				Content:   "上次讨论过部署和方案。",
				CreatedAt: now.Add(-30 * 24 * time.Hour),
			},
			{
				ID:        "low-new",
				SessionID: "s1",
				UserID:    "u1",
				Role:      "user",
				Content:   "部署完成了。",
				CreatedAt: now,
			},
			{
				ID:        "high-new",
				SessionID: "s1",
				UserID:    "u1",
				Role:      "assistant",
				Content:   "部署、方案和回滚步骤都确认过了。",
				CreatedAt: now.Add(-time.Hour),
			},
		},
	})

	hits, err := searcher.Search(context.Background(), &SearchQuery{
		SessionID: "s1",
		UserID:    "u1",
		Keywords:  []string{"部署", "方案", "回滚"},
		Match:     MatchAny,
	})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	got := []string{hits[0].Message.ID, hits[1].Message.ID, hits[2].Message.ID}
	want := []string{"high-new", "high-old", "low-new"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order = %v, want %v", got, want)
		}
	}
}

func TestKeywordSearcherPrefersRecentWhenCoverageEqual(t *testing.T) {
	now := time.Now()
	searcher := NewKeywordSearcher(&fakeKeywordStore{
		messages: []*Message{
			{
				ID:        "old",
				SessionID: "s1",
				UserID:    "u1",
				Role:      "user",
				Content:   "部署方案已确认。",
				CreatedAt: now.Add(-30 * 24 * time.Hour),
			},
			{
				ID:        "new",
				SessionID: "s1",
				UserID:    "u1",
				Role:      "user",
				Content:   "部署方案已确认。",
				CreatedAt: now,
			},
		},
	})

	hits, err := searcher.Search(context.Background(), &SearchQuery{
		SessionID: "s1",
		UserID:    "u1",
		Keywords:  []string{"部署", "方案"},
		Match:     MatchAll,
	})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 2 || hits[0].Message.ID != "new" {
		t.Fatalf("hits order should prefer recent message: %+v", hits)
	}
}
