package tests

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"server/internal/modules/livemode"
)

func TestLiveModeDemoReplies(t *testing.T) {
	const prompt = "欢迎观众并介绍今晚的节目"
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Temperature float32
			Messages    []struct {
				Role    string
				Content json.RawMessage
			}
			Tools []upstreamChatTool
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if calls.Add(1) == 1 {
			var audience string
			for _, message := range body.Messages {
				if message.Role == "user" {
					audience = string(message.Content)
				}
			}
			if body.Temperature != 0.4 || len(body.Messages) < 2 ||
				!strings.Contains(string(body.Messages[0].Content), prompt) ||
				!strings.Contains(audience, "今天直播有什么安排？") || !strings.Contains(audience, "小心心") {
				t.Errorf("live prompt, event batch or temperature missing: %+v", body)
			}
			for _, tool := range body.Tools {
				if slices.Contains([]string{"save_memory", "search_memory", "update_character"}, tool.Function.Name) {
					t.Errorf("unexpected tool in live mode: %s", tool.Function.Name)
				}
			}
			chunk(w, map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{
				"index": 0, "id": "expression_1", "type": "function", "function": map[string]string{
					"name": "set_expression", "arguments": `{"expression":"happy"}`,
				},
			}}}, nil)
			chunk(w, map[string]any{}, "tool_calls")
		} else {
			chunk(w, map[string]any{"role": "assistant", "content": "谢谢小橘的小心心！"}, "stop")
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	app := newApp(t)
	configure(t, app, upstream.URL, false)

	getState := func() livemode.Snapshot {
		return decode[livemode.Snapshot](t, request(t, app, "GET", "/live/state", nil))
	}
	initial := getState()
	if initial.Running || initial.Config.Mode != "manual" {
		t.Fatalf("unexpected default state %+v", initial)
	}
	config := initial.Config
	config.CharacterID, config.Prompt, config.Temperature = "mao", prompt, 0.4
	config.Room, config.PollSeconds, config.Mode = "https://live.douyin.com/123456", 30, "auto"
	config.BatchSize, config.ReplySeconds = 2, 120
	state := decode[livemode.Snapshot](t, request(t, app, "PUT", "/live/config", config))
	if state.Config.Room != "123456" || state.Config.PollSeconds != 30 {
		t.Fatalf("configuration was not saved: %+v", state.Config)
	}
	state = decode[livemode.Snapshot](t, request(t, app, "POST", "/live/start", map[string]bool{"demo": true}))
	if !state.Running || !state.Demo || !state.AutoReady || len(state.Events) != 5 || state.Counts[livemode.Gift] != 3 {
		t.Fatalf("unexpected demo state %+v", state)
	}
	replyRequest := map[string]string{"session_id": state.SessionID}
	result := decode[struct{ Accepted bool }](t, request(t, app, "POST", "/live/reply", replyRequest))
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
	if reply.Error != "" || reply.Expression != "happy" || reply.Text != "谢谢小橘的小心心！" ||
		!slices.Equal(reply.EventIDs, []int{state.Events[0].ID, state.Events[1].ID}) || calls.Load() != 2 {
		t.Fatalf("unexpected agent outcome %+v, calls %d", reply, calls.Load())
	}
	state = decode[livemode.Snapshot](t, request(t, app, "POST", "/live/demo-event", map[string]string{"kind": "chat"}))
	if state.Pending != 1 || state.AutoReady {
		t.Fatalf("unexpected state during cooldown: %+v", state)
	}
	config = state.Config
	config.Mode = "paused"
	decode[livemode.Snapshot](t, request(t, app, "PUT", "/live/config", config))
	result = decode[struct{ Accepted bool }](t, request(t, app, "POST", "/live/reply", map[string]any{
		"session_id": state.SessionID, "event_id": state.Events[0].ID,
	}))
	if result.Accepted {
		t.Fatal("paused AI accepted a reply")
	}
	state = decode[livemode.Snapshot](t, request(t, app, "POST", "/live/stop", nil))
	if state.Running || state.Config.Mode != "paused" {
		t.Fatalf("unexpected stopped state %+v", state)
	}
	reloaded, err := livemode.New(app.DB, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	stored := reloaded.Snapshot().Config
	if stored.Prompt != prompt || stored.Temperature != 0.4 || stored.CharacterID != "mao" || stored.Mode != "paused" {
		t.Fatalf("unexpected persisted config %+v", stored)
	}
}
