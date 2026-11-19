package tests

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"server/internal/model"
)

func TestScreenWatchRoutesModelsWithoutPersistingCapture(t *testing.T) {
	const observation = "屏幕上出现 403 Access Denied"
	const frame = "data:image/jpeg;base64,Y2FwdHVyZQ=="
	type input struct {
		Model    string          `json:"model"`
		Messages json.RawMessage `json:"messages"`
		Stream   bool            `json:"stream"`
	}
	upstreamRequests := make(chan input, 8)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in input
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			t.Error(err)
		}
		upstreamRequests <- in
		if !in.Stream {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"id":"test","object":"chat.completion","created":1,"model":"fast-model","choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"%s"}}]}`, observation)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		chunk(w, map[string]string{"role": "assistant", "content": "收到"}, nil)
		chunk(w, map[string]string{}, "stop")
		io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	app := newApp(t)
	configure(t, app, upstream.URL, false)
	if w := request(t, app, "PUT", "/settings/screen-watch", map[string]any{
		"fast":   map[string]string{"provider": "openai", "model": "fast-model"},
		"vision": map[string]string{"provider": "openai", "model": "vision-model"},
	}); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	// Saving general settings must preserve the two independent watch roles.
	configure(t, app, upstream.URL, false)
	conv := conversation(t, app)
	path := "/conversations/" + conv.ID + "/messages"

	send := func(question, visibleText, image string) {
		t.Helper()
		body := map[string]any{"text": question}
		if visibleText != "" || image != "" {
			body["screen_context"] = map[string]string{"text": visibleText, "image": image}
		}
		w := request(t, app, "POST", path, body)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"status":"complete"`) ||
			!strings.Contains(w.Body.String(), "收到") {
			t.Fatal(w.Body.String())
		}
		if strings.Contains(w.Body.String(), observation) || strings.Contains(w.Body.String(), frame) {
			t.Fatal("the recorded user message must not contain the screen context")
		}
	}
	expect := func(modelName, included, excluded string) {
		t.Helper()
		select {
		case in := <-upstreamRequests:
			messages := string(in.Messages)
			if in.Model != modelName || (included != "" && !strings.Contains(messages, included)) ||
				(excluded != "" && strings.Contains(messages, excluded)) {
				t.Fatalf("unexpected model payload: %s %s", in.Model, messages)
			}
		default:
			t.Fatalf("expected request for %s", modelName)
		}
	}

	send("刚才页面有什么异常？", observation+strings.Repeat("无关文字", 160), "")
	expect("fast-model", observation, frame)
	expect("test-model", observation, "无关文字")
	send("看下这个图标", observation, frame)
	expect("vision-model", frame, "无关文字")
	send("先聊点别的", "", "")
	expect("test-model", "先聊点别的", observation)

	for _, saved := range decode[[]model.Message](t, request(t, app, "GET", path, nil)) {
		if strings.Contains(saved.Content, observation) || saved.Image != "" {
			t.Fatalf("transient input leaked into history: %+v", saved)
		}
	}
}
