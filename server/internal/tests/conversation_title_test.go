// 本文件覆盖会话标题：首条消息自动生成、重命名生效、后续消息不覆盖标题，
// 以及重命名不改变活跃时间。

package tests

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"server/internal/model"
)

// TestConversationTitleSurvivesNewTurns 校验标题生成与重命名规则：自动标题取首条
// 消息并去除首尾空白，手动标题不会被后续对话覆盖。
func TestConversationTitleSurvivesNewTurns(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		chunk(w, map[string]any{"role": "assistant", "content": "OK"}, nil)
		chunk(w, map[string]any{}, "stop")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer up.Close()
	app := newApp(t)
	configure(t, app, up.URL, false)
	conv := conversation(t, app)
	path := "/conversations/" + conv.ID
	post := func(text string) {
		t.Helper()
		w := request(t, app, http.MethodPost, path+"/messages", map[string]string{"text": text})
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"type":"done"`) {
			t.Fatal(w.Body.String())
		}
	}
	load := func() model.Conversation {
		t.Helper()
		return decode[[]model.Conversation](t, request(t, app, http.MethodGet, "/conversations", nil))[0]
	}
	rename := func(title string) {
		t.Helper()
		w := request(t, app, http.MethodPut, path, map[string]string{"title": title})
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
	}
	post("  首条消息  ")
	first := load()
	if first.Title != "首条消息" {
		t.Fatalf("got initial title %q", first.Title)
	}
	rename("  每日计划  ")
	renamed := load()
	if renamed.Title != "每日计划" || !renamed.UpdatedAt.Equal(first.UpdatedAt) {
		t.Fatalf("renaming changed conversation activity or did not trim title: %+v", renamed)
	}
	post("下一条消息")
	if after := load(); after.Title != "每日计划" || !after.UpdatedAt.After(renamed.UpdatedAt) {
		t.Fatalf("a new message lost the title or activity time: %+v", after)
	}
	rename("新的对话")
	post("再次继续")
	if got := load().Title; got != "新的对话" {
		t.Fatalf("a manually chosen default-like title was overwritten: %q", got)
	}
}
