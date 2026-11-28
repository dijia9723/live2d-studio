// 本文件覆盖模型兼容性与连接检测：推理模型参数、流式校验、ReAct 容错与错误脱敏。

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

// TestModelParametersAndStreamingConnectionCheck 校验标准模型与推理模型各自收到
// 兼容的生成参数，且连接检测复用与聊天相同的流式链路。
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

// TestConnectionCheckRejectsStreamFailureAndEmptyContent 校验连接检测不会因
// 非流式接口可用而误报成功，也不泄露上游私有错误、不污染会话历史。
func TestConnectionCheckRejectsStreamFailureAndEmptyContent(t *testing.T) {
	for _, scenario := range []string{"stream-rejected", "empty-response"} {
		t.Run(scenario, func(t *testing.T) {
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var req struct{ Stream bool }
				_ = json.NewDecoder(r.Body).Decode(&req)
				if !req.Stream {
					// 该上游的非流式响应是可用的，旧实现会因此误报成功，
					// 而实际聊天走流式仍然失败。
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

// TestConnectionCheckIncludesConfiguredTools 校验开启工具后，连接检测会携带完整工具声明。
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
	if w := request(t, app, "POST", "/settings/test", nil); w.Code != 200 || tools.Load() != 4 {
		t.Fatalf("tools configuration was not exercised by connection check: %s", w.Body)
	}
}

// TestReActRecoversFromInvalidAndUnknownTools 校验参数非法的工具与未知工具都会
// 转为失败轨迹，回复继续生成且不泄露模型返回的私有内容。
func TestReActRecoversFromInvalidAndUnknownTools(t *testing.T) {
	var calls atomic.Int32
	const private = "private-value-do-not-expose"
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req := readUpstreamChatRequest(t, r)
		if req == nil {
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if calls.Add(1) == 1 {
			chunk(w, map[string]any{"role": "assistant", "tool_calls": []any{
				map[string]any{"index": 0, "id": "invalid", "type": "function", "function": map[string]string{"name": "set_expression", "arguments": `{"expression":` + private}},
				map[string]any{"index": 1, "id": "unknown", "type": "function", "function": map[string]string{"name": private, "arguments": `{}`}},
			}}, nil)
			chunk(w, map[string]any{}, "tool_calls")
		} else {
			var toolMessages int
			for _, message := range req.Messages {
				if message.Role == "tool" {
					toolMessages++
					if !strings.Contains(message.Text, `"error"`) || strings.Contains(message.Text, private) {
						t.Errorf("unexpected tool error payload: %q", message.Text)
					}
				}
			}
			if toolMessages != 2 {
				t.Errorf("expected both tool results, got %d", toolMessages)
			}
			chunk(w, map[string]any{"role": "assistant", "content": "工具暂不可用。"}, nil)
			chunk(w, map[string]any{}, "stop")
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer up.Close()
	app := newApp(t)
	configure(t, app, up.URL, true)
	conv := conversation(t, app)
	path := "/conversations/" + conv.ID + "/messages"
	w := request(t, app, "POST", path, map[string]string{"text": "试试工具"})
	if calls.Load() != 2 || strings.Contains(w.Body.String(), private) || strings.Contains(w.Body.String(), `"type":"error"`) {
		t.Fatalf("tool failure aborted the reply or exposed private input: %s", w.Body)
	}
	messages := decode[[]model.Message](t, request(t, app, "GET", path, nil))
	if len(messages) != 2 || messages[1].Status != "complete" || len(messages[1].ToolRuns) != 2 {
		t.Fatalf("unexpected reply: %+v", messages)
	}
	runs := messages[1].ToolRuns
	if runs[0].Name != "set_expression" || runs[1].Name != "unknown_tool" || runs[0].Status != model.ToolFailed || runs[1].Status != model.ToolFailed {
		t.Fatalf("unexpected tool traces: %+v", runs)
	}
}

// TestProviderErrorDetailsPersistSafely 覆盖各类上游 HTTP 错误：返回可读的分类
// 信息并持久化，同时不泄露原始错误正文。
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
