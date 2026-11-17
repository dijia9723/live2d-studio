package tests

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"server/internal/config"
	"server/internal/model"
)

func TestModelParametersAndStreamingConnectionCheck(t *testing.T) {
	for _, name := range []string{"gpt-5.6-sol", "o3-mini", "gpt-4o-mini"} {
		t.Run(name, func(t *testing.T) {
			var calls atomic.Int32
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var req map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
					t.Error(err)
				}
				if string(req["stream"]) != "true" {
					t.Error("connection test did not use the same streaming path as chat")
				}
				if name == "gpt-4o-mini" {
					if len(req["temperature"]) == 0 || len(req["max_tokens"]) == 0 {
						t.Error("standard model generation parameters were lost")
					}
				} else {
					if len(req["temperature"]) > 0 || len(req["max_tokens"]) > 0 || string(req["max_completion_tokens"]) != "2048" {
						t.Error("reasoning model received incompatible generation parameters")
					}
				}
				calls.Add(1)
				w.Header().Set("Content-Type", "text/event-stream")
				chunk(w, map[string]any{"role": "assistant", "content": "OK"}, nil)
				chunk(w, map[string]any{}, "stop")
				fmt.Fprint(w, "data: [DONE]\n\n")
			}))
			defer up.Close()
			app := newApp(t)
			cfg := config.Defaults().Settings
			cfg.LLM.BaseURL = up.URL + "/v1"
			cfg.LLM.Model = name
			if w := request(t, app, "PUT", "/settings", cfg); w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			if w := request(t, app, "POST", "/settings/test", nil); w.Code != 200 {
				t.Fatalf("connection test failed: %s", w.Body)
			}
			conv := conversation(t, app)
			w := request(t, app, "POST", "/conversations/"+conv.ID+"/messages", map[string]string{"text": "test"})
			if !strings.Contains(w.Body.String(), `"type":"delta"`) || strings.Contains(w.Body.String(), `"type":"error"`) {
				t.Fatal(w.Body.String())
			}
			if calls.Load() != 2 {
				t.Fatalf("expected connection check and conversation upstream calls, got %d", calls.Load())
			}
		})
	}
}

func TestConnectionCheckRejectsStreamFailureAndEmptyContent(t *testing.T) {
	for _, scenario := range []string{"stream-rejected", "empty-response"} {
		t.Run(scenario, func(t *testing.T) {
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var req struct{ Stream bool }
				_ = json.NewDecoder(r.Body).Decode(&req)
				if !req.Stream {
					// This endpoint's non-streaming response works. The old test
					// incorrectly reported success even though chat could not work.
					w.Header().Set("Content-Type", "application/json")
					fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":"OK"}}]}`)
					return
				}
				if scenario == "stream-rejected" {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(400)
					fmt.Fprint(w, `{"error":{"message":"stream unsupported; secret-key-do-not-expose"}}`)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				chunk(w, map[string]any{"role": "assistant"}, "stop")
				fmt.Fprint(w, "data: [DONE]\n\n")
			}))
			defer up.Close()
			app := newApp(t)
			configure(t, app, up.URL, false)
			w := request(t, app, "POST", "/settings/test", nil)
			if w.Code != 502 || strings.Contains(w.Body.String(), "secret-key") || strings.Contains(w.Body.String(), `"connected":true`) {
				t.Fatalf("false success or private upstream error exposed: %s", w.Body)
			}
			var count int64
			app.DB.Model(&model.Message{}).Count(&count)
			if count != 0 {
				t.Error("connection test polluted conversation history")
			}
		})
	}
}

func TestConnectionCheckIncludesConfiguredTools(t *testing.T) {
	var tools atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Tools []any }
		_ = json.NewDecoder(r.Body).Decode(&body)
		tools.Store(int32(len(body.Tools)))
		w.Header().Set("Content-Type", "text/event-stream")
		chunk(w, map[string]any{"role": "assistant", "content": "OK"}, nil)
		chunk(w, map[string]any{}, "stop")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer up.Close()
	app := newApp(t)
	configure(t, app, up.URL, true)
	if w := request(t, app, "POST", "/settings/test", nil); w.Code != 200 || tools.Load() != 2 {
		t.Fatalf("tools configuration was not exercised by connection check: %s", w.Body)
	}
}

func TestProviderErrorDetailsPersistSafely(t *testing.T) {
	for _, status := range []int{400, 401, 403, 404, 429, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				fmt.Fprint(w, `{"error":{"message":"secret-key-do-not-expose; http://private-gateway.example"}}`)
			}))
			defer up.Close()
			app := newApp(t)
			configure(t, app, up.URL, false)
			conv := conversation(t, app)
			w := request(t, app, "POST", "/conversations/"+conv.ID+"/messages", map[string]string{"text": "test"})
			if !strings.Contains(w.Body.String(), fmt.Sprint(status)) || strings.Contains(w.Body.String(), "secret-key") || strings.Contains(w.Body.String(), "private-gateway") {
				t.Fatal("error classification missing or raw upstream details leaked")
			}
			msgs := decode[[]model.Message](t, request(t, app, "GET", "/conversations/"+conv.ID+"/messages", nil))
			if len(msgs) != 2 || msgs[1].Status != "failed" || !strings.Contains(msgs[1].Error, fmt.Sprint(status)) {
				t.Fatal("safe error details were not persisted")
			}
		})
	}
}
