package livemode

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"server/internal/config"
	"server/internal/migrate"
	"server/internal/model"
	"server/internal/modules/agent"
	"server/internal/modules/character"
	"server/internal/modules/memory"
	"server/internal/modules/settings"
)

func TestLiveModeReplies(t *testing.T) {
	const prompt = "欢迎观众并介绍今晚的节目"
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Temperature float32
			Messages    []struct {
				Role    string
				Content json.RawMessage
			}
			Tools []struct{ Function struct{ Name string } }
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		var audience string
		for _, message := range body.Messages {
			if message.Role == "user" {
				audience = string(message.Content)
			}
		}
		switch calls.Add(1) {
		case 1:
			if body.Temperature != 0.4 || len(body.Messages) < 2 ||
				!strings.Contains(string(body.Messages[0].Content), prompt) ||
				!strings.Contains(string(body.Messages[0].Content), "可以直接念的中文台词") ||
				strings.Contains(string(body.Messages[0].Content), "私聊记忆测试内容") ||
				!strings.Contains(audience, "今天直播有什么安排？") || !strings.Contains(audience, "小心心") ||
				!strings.Contains(audience, "老狗") || !strings.Contains(audience, "49哥") ||
				strings.Contains(audience, "稳如老狗") || strings.Contains(audience, "dou38972712749") || strings.Contains(audience, "837261") {
				t.Errorf("live prompt, event batch or temperature missing: %+v", body)
			}
			for _, tool := range body.Tools {
				if slices.Contains([]string{"save_memory", "search_memories", "update_character"}, tool.Function.Name) {
					t.Errorf("unexpected tool in live mode: %s", tool.Function.Name)
				}
			}
			chunk(w, map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{
				"index": 0, "id": "expression_1", "type": "function", "function": map[string]string{
					"name": "set_expression", "arguments": `{"expression":"happy"}`,
				},
			}}}, nil)
			chunk(w, map[string]any{}, "tool_calls")
		case 2:
			chunk(w, map[string]any{"role": "assistant", "content": "49哥，小心心收到啦！"}, "stop")
		case 3:
			if !strings.Contains(audience, "那下一场呢？") || !strings.Contains(audience, "今天直播有什么安排？") ||
				!strings.Contains(audience, "49哥，小心心收到啦！") || !strings.Contains(audience, "related_chat") ||
				strings.Contains(audience, "另一位观众的话") || strings.Contains(audience, "后来发的弹幕") || strings.Contains(audience, "837261") {
				t.Errorf("unexpected follow-up context: %s", audience)
			}
			chunk(w, map[string]any{"role": "assistant", "content": "直接接着聊下一场。"}, "stop")
		case 4:
			if len(body.Tools) != 0 || !strings.Contains(audience, "今天直播有什么安排？") || !strings.Contains(audience, "小心心") ||
				!strings.Contains(audience, "直接接着聊下一场。") || strings.Contains(audience, "稳如老狗") {
				t.Errorf("unexpected session summary input: %s", audience)
			}
			chunk(w, map[string]any{"role": "assistant", "content": "观众主要在聊节目安排。"}, "stop")
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	path := filepath.Join(t.TempDir(), "studio.db")
	db, err := gorm.Open(sqlite.Open(path), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err = migrate.Run(db, true); err != nil {
		t.Fatal(err)
	}
	cfg := config.Defaults()
	cfg.Settings.LLM.BaseURL = upstream.URL + "/v1"
	cfg.Settings.LLM.APIKey = "test-key"
	cfg.Settings.LLM.Model = "test-model"
	roles := &character.Service{DB: db}
	memories := &memory.Service{DB: db}
	if _, err := memories.Create(context.Background(), "mao", "私聊记忆测试内容"); err != nil {
		t.Fatal(err)
	}
	modelSettings := settings.New(db, cfg)
	streamer := &agent.Service{Characters: roles, Memory: memories}
	service, err := New(db, modelSettings, roles, streamer)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.Stop() })
	connected := make(chan struct{})
	var receive func(Event)
	var updateConnection func(connection)
	service.connect = func(_ context.Context, _ Config, emit func(Event), update func(connection)) {
		update(connection{Phase: "waiting", offline: true})
		update(connection{Phase: "live", Title: "第一场"})
		emit(Event{Kind: Chat, Viewer: "稳如老狗", Text: "今天直播有什么安排？", viewerID: 837261})
		emit(Event{Kind: Gift, Viewer: "dou38972712749", Text: "小心心", Count: 3})
		emit(Event{Kind: Like, Count: 16})
		emit(Event{Kind: Follow})
		emit(Event{Kind: Enter})
		receive = emit
		updateConnection = update
		close(connected)
	}
	router := gin.New()
	(&Module{Service: service}).Register(router.Group("/api/v1"))
	request := func(method, path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(method, "/api/v1"+path, bytes.NewReader(data))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}

	getState := func() Snapshot {
		return decode[Snapshot](t, request("GET", "/live/state", nil))
	}
	initial := getState()
	if initial.Running || initial.Config.Mode != "manual" {
		t.Fatalf("unexpected default state %+v", initial)
	}
	config := initial.Config
	config.CharacterID, config.Prompt, config.Temperature = "mao", prompt, 0.4
	config.Room, config.PollSeconds, config.Mode = "https://live.douyin.com/123456", 30, "auto"
	config.BatchSize, config.ReplySeconds = 2, 120
	state := decode[Snapshot](t, request("PUT", "/live/config", config))
	if state.Config.Room != "123456" || state.Config.PollSeconds != 30 {
		t.Fatalf("configuration was not saved: %+v", state.Config)
	}
	decode[Snapshot](t, request("POST", "/live/start", nil))
	select {
	case <-connected:
	case <-time.After(5 * time.Second):
		t.Fatal("fixture events did not arrive")
	}
	state = getState()
	if !state.Running || !state.AutoReady || state.RecordingID == "" || len(state.Events) != 5 || state.Counts[Gift] != 3 ||
		state.Events[0].Viewer != "稳如老狗" || state.Events[1].Viewer != "dou38972712749" {
		t.Fatalf("unexpected live state %+v", state)
	}
	firstID := state.RecordingID
	if w := request("POST", "/live/sessions/"+firstID+"/summary", nil); w.Code != http.StatusConflict {
		t.Fatalf("recording summary request: %d %s", w.Code, w.Body)
	}
	replyRequest := map[string]string{"session_id": state.SessionID}
	result := decode[struct{ Accepted bool }](t, request("POST", "/live/reply", replyRequest))
	if !result.Accepted {
		t.Fatal("automatic batch was not accepted")
	}
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		state = getState()
		if !state.Busy {
			break
		}
	}
	if len(state.Replies) != 1 {
		t.Fatalf("unexpected replies %+v", state)
	}
	reply := state.Replies[0]
	if reply.Error != "" || reply.Expression != "happy" || reply.Text != "49哥，小心心收到啦！" ||
		!slices.Equal(reply.EventIDs, []int{state.Events[0].ID, state.Events[1].ID}) || calls.Load() != 2 {
		t.Fatalf("unexpected agent outcome %+v, calls %d", reply, calls.Load())
	}
	for range eventLimit {
		receive(Event{Kind: Like})
	}
	receive(Event{Kind: Chat, Viewer: "稳如老狗", Text: "另一位观众的话", viewerID: 837262})
	receive(Event{Kind: Chat, Viewer: "新昵称", Text: "那下一场呢？", viewerID: 837261})
	receive(Event{Kind: Chat, Viewer: "新昵称", Text: "后来发的弹幕", viewerID: 837261})
	state = getState()
	if state.Pending != 3 || state.AutoReady {
		t.Fatalf("unexpected state during cooldown: %+v", state)
	}
	result = decode[struct{ Accepted bool }](t, request("POST", "/live/reply", map[string]any{
		"session_id": state.SessionID, "event_id": state.Events[len(state.Events)-2].ID,
	}))
	if !result.Accepted {
		t.Fatal("follow-up reply was not accepted")
	}
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		state = getState()
		if !state.Busy {
			break
		}
	}
	if len(state.Replies) != 2 || state.Replies[1].Text != "直接接着聊下一场。" || state.Replies[1].Error != "" || calls.Load() != 3 {
		t.Fatalf("unexpected follow-up replies %+v, calls %d", state.Replies, calls.Load())
	}
	config = state.Config
	config.Mode = "paused"
	decode[Snapshot](t, request("PUT", "/live/config", config))
	result = decode[struct{ Accepted bool }](t, request("POST", "/live/reply", map[string]any{
		"session_id": state.SessionID, "event_id": state.Events[0].ID,
	}))
	if result.Accepted {
		t.Fatal("paused AI accepted a reply")
	}
	updateConnection(connection{Phase: "retrying"})
	updateConnection(connection{Phase: "live", Title: "第一场"})
	if state = getState(); state.RecordingID != firstID {
		t.Fatalf("reconnect split the broadcast: %+v", state)
	}
	updateConnection(connection{Phase: "waiting", offline: true})
	if state = getState(); !state.Running || state.RecordingID != "" {
		t.Fatalf("confirmed offline did not end the recording: %+v", state)
	}
	updateConnection(connection{Phase: "connecting", Title: "第二场"})
	receive(Event{Kind: Follow})
	if state = getState(); state.RecordingID == "" || state.RecordingID == firstID || state.Counts[Follow] != 1 || len(state.Events) != 1 {
		t.Fatalf("unexpected next broadcast: %+v", state)
	}
	secondID := state.RecordingID
	state = decode[Snapshot](t, request("POST", "/live/stop", nil))
	if state.Running || state.Config.Mode != "paused" {
		t.Fatalf("unexpected stopped state %+v", state)
	}
	listing := decode[archivePage](t, request("GET", "/live/sessions", nil))
	if len(listing.Sessions) != 2 || listing.Sessions[0].ID != secondID || listing.Sessions[1].ID != firstID {
		t.Fatalf("unexpected session history: %+v", listing)
	}
	firstPath := "/live/sessions/" + firstID
	first := decode[archiveDetails](t, request("GET", firstPath, nil))
	if first.Status != "ended" || first.EndedAt == nil || first.Title != "第一场" || first.Counts[string(Gift)] != 3 ||
		first.Counts[string(Chat)] != 4 || first.Counts[string(Like)] != eventLimit+16 || first.ReplyCount != 2 ||
		len(first.Gifts) != 1 || first.Gifts[0].Name != "小心心" || first.Gifts[0].Count != 3 {
		t.Fatalf("unexpected totals after window eviction: %+v", first)
	}
	second := decode[archiveDetails](t, request("GET", "/live/sessions/"+secondID, nil))
	if second.Status != "ended" || second.Title != "第二场" || len(second.Counts) != 1 || second.Counts[string(Follow)] != 1 {
		t.Fatalf("unexpected second session totals: %+v", second)
	}
	summary := decode[archiveDetails](t, request("POST", firstPath+"/summary", nil))
	if summary.Summary != "观众主要在聊节目安排。" || calls.Load() != 4 {
		t.Fatalf("unexpected summary: %+v", summary)
	}
	interrupted := model.LiveSession{ID: "interrupted-fixture", Room: "123456", StartedAt: time.Now(), Status: "recording"}
	if err := db.Create(&interrupted).Error; err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := gorm.Open(sqlite.Open(path), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	reopenedSQL, err := reopened.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopenedSQL.Close() })
	reloaded, err := New(reopened, modelSettings, roles, streamer)
	if err != nil {
		t.Fatal(err)
	}
	stored := reloaded.Snapshot().Config
	if stored.Prompt != prompt || stored.Temperature != 0.4 || stored.CharacterID != "mao" || stored.Mode != "paused" {
		t.Fatalf("unexpected persisted config %+v", stored)
	}
	storedDetail, err := reloaded.summarizeArchive(context.Background(), firstID)
	if err != nil || storedDetail.Summary != summary.Summary || calls.Load() != 4 {
		t.Fatalf("summary was not reused after reload: %+v, %v", storedDetail, err)
	}
	recovered, err := reloaded.archiveDetails(context.Background(), interrupted.ID)
	if err != nil || recovered.Status != "interrupted" || recovered.EndedAt != nil {
		t.Fatalf("unexpected recovered recording: %+v, %v", recovered, err)
	}
}

func decode[T any](t *testing.T, response *httptest.ResponseRecorder) T {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Fatalf("status %d: %s", response.Code, response.Body)
	}
	var envelope struct{ Data T }
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.Data
}

func chunk(w http.ResponseWriter, delta any, finish any) {
	data, _ := json.Marshal(map[string]any{
		"id": "test", "object": "chat.completion.chunk", "created": 1, "model": "test-model",
		"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}},
	})
	fmt.Fprintf(w, "data: %s\n\n", data)
}
