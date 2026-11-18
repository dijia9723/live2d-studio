// Package tests 是跨模块的端到端测试集合：用真实的 bootstrap 装配与 httptest
// 上游模拟 OpenAI 兼容服务，覆盖对话、工具、设置、导入与语音等链路。
package tests

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"server/internal/bootstrap"
	"server/internal/config"
	"server/internal/model"
)

// newApp 为每个用例装配独立临时数据目录，避免 SQLite 状态相互影响。
func newApp(t *testing.T) *bootstrap.App {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	app, err := bootstrap.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	return app
}

// request 发送带客户端标识的 JSON 请求，模拟前端调用本地 API。
func request(t *testing.T, app *bootstrap.App, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var data []byte
	switch b := body.(type) {
	case []byte:
		data = b
	case nil:
	default:
		var err error
		data, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, "http://127.0.0.1:12393/api/v1"+path, bytes.NewReader(data))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Studio-Client", "1")
	w := httptest.NewRecorder()
	app.Router.ServeHTTP(w, r)
	return w
}

// decode 校验响应成功并取出统一响应体中的 data 字段。
func decode[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	var result struct {
		Data T `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result.Data
}

// configure 把模型与语音指向测试上游，并写入设置。
func configure(t *testing.T, app *bootstrap.App, base string, tools bool) {
	t.Helper()
	cfg := config.Defaults().Settings
	cfg.LLM.BaseURL = base + "/v1"
	cfg.LLM.APIKey = "test-key"
	cfg.LLM.Model = "test-model"
	cfg.LLM.ToolsEnabled = tools
	if w := request(t, app, "PUT", "/settings", cfg); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
}

// conversation 为默认角色 mao 创建一个新会话。
func conversation(t *testing.T, app *bootstrap.App) model.Conversation {
	t.Helper()
	return decode[model.Conversation](t, request(t, app, "POST", "/conversations", map[string]string{"character_id": "mao"}))
}

// chunk 按 OpenAI 流式格式写出一帧并立即刷新，模拟真实上游的分片下发。
func chunk(w http.ResponseWriter, delta any, finish any) {
	data, _ := json.Marshal(map[string]any{"id": "test", "object": "chat.completion.chunk", "created": 1, "model": "test-model", "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}})
	fmt.Fprintf(w, "data: %s\n\n", data)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}

// TestEinoStreamingAndPersistence 覆盖流式增量输出、历史透传、标题生成与删除会话时级联清理。
func TestEinoStreamingAndPersistence(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("invalid provider request")
		}
		var body struct {
			Model    string
			Stream   bool
			Messages []struct {
				Role    string
				Content any
			}
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Error("invalid JSON")
		}
		if body.Model != "test-model" || !body.Stream {
			t.Error("Eino configuration lost")
		}
		if calls.Add(1) == 2 && len(body.Messages) < 4 {
			t.Error("history was not sent to model")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		chunk(w, map[string]any{"role": "assistant", "content": "你好，"}, nil)
		chunk(w, map[string]any{"content": "我是 Mao。"}, nil)
		chunk(w, map[string]any{}, "stop")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	app := newApp(t)
	configure(t, app, upstream.URL, false)
	conv := conversation(t, app)
	for _, text := range []string{"你好", "再聊一会"} {
		w := request(t, app, "POST", "/conversations/"+conv.ID+"/messages", map[string]string{"text": text})
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"type":"delta"`) || !strings.Contains(w.Body.String(), `"type":"done"`) || strings.Contains(w.Body.String(), `"type":"error"`) {
			t.Fatal(w.Body.String())
		}
	}
	msgs := decode[[]model.Message](t, request(t, app, "GET", "/conversations/"+conv.ID+"/messages", nil))
	if len(msgs) != 4 || msgs[1].Content != "你好，我是 Mao。" || msgs[1].Status != "complete" {
		t.Fatalf("unexpected persisted messages: %+v", msgs)
	}
	convs := decode[[]model.Conversation](t, request(t, app, "GET", "/conversations", nil))
	if convs[0].Title != "你好" {
		t.Fatal("title was not generated")
	}
	if w := request(t, app, "DELETE", "/conversations/"+conv.ID, nil); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var count int64
	app.DB.Model(&model.Message{}).Count(&count)
	if count != 0 {
		t.Fatal("messages left after conversation deletion")
	}
}

// TestEinoReActToolCalling 覆盖工具声明、工具结果回传模型与执行轨迹持久化。
func TestEinoReActToolCalling(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := readUpstreamChatRequest(t, r)
		if body == nil {
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if calls.Add(1) == 1 {
			advertised := make(map[string]bool, len(body.Tools))
			for _, tool := range body.Tools {
				advertised[tool.Function.Name] = true
			}
			for _, name := range []string{
				"current_time", "set_expression", "calculate", "get_character_actions", "play_motion",
				"set_model_expression", "update_character", "search_memories", "save_memory",
			} {
				if !advertised[name] {
					t.Errorf("request did not advertise %s", name)
				}
			}
			chunk(w, map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "expression_1", "type": "function", "function": map[string]any{"name": "set_expression", "arguments": `{"expression":"happy"}`}}}}, nil)
			chunk(w, map[string]any{}, "tool_calls")
		} else {
			found := false
			for _, m := range body.Messages {
				if m.Role == "tool" {
					found = true
				}
			}
			if !found {
				t.Error("tool result not sent back to model")
			}
			chunk(w, map[string]any{"role": "assistant", "content": "好开心见到你！"}, nil)
			chunk(w, map[string]any{}, "stop")
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	app := newApp(t)
	configure(t, app, upstream.URL, true)
	conv := conversation(t, app)
	w := request(t, app, "POST", "/conversations/"+conv.ID+"/messages", map[string]string{"text": "开心一点"})
	if !strings.Contains(w.Body.String(), `"expression":"happy"`) || !strings.Contains(w.Body.String(), "好开心见到你") || strings.Contains(w.Body.String(), `"type":"error"`) {
		t.Fatal(w.Body.String())
	}
	if calls.Load() != 2 {
		t.Fatalf("ReAct made %d requests", calls.Load())
	}
	if !strings.Contains(w.Body.String(), `"type":"tool"`) || !strings.Contains(w.Body.String(), `"status":"running"`) {
		t.Fatal("tool progress was not streamed")
	}
	messages := decode[[]model.Message](t, request(t, app, "GET", "/conversations/"+conv.ID+"/messages", nil))
	if len(messages) != 2 || len(messages[1].ToolRuns) != 1 || messages[1].ToolRuns[0].Name != "set_expression" || messages[1].ToolRuns[0].Status != model.ToolCompleted {
		t.Fatalf("tool result not persisted: %+v", messages)
	}
}

// TestProviderFailureIsPersisted 校验上游失败时错误事件会下发，并把失败状态持久化。
func TestProviderFailureIsPersisted(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, `{"error":{"message":"bad key"}}`, 401) }))
	defer up.Close()
	app := newApp(t)
	configure(t, app, up.URL, false)
	conv := conversation(t, app)
	w := request(t, app, "POST", "/conversations/"+conv.ID+"/messages", map[string]string{"text": "test"})
	if !strings.Contains(w.Body.String(), `"type":"error"`) {
		t.Fatal(w.Body.String())
	}
	msgs := decode[[]model.Message](t, request(t, app, "GET", "/conversations/"+conv.ID+"/messages", nil))
	if len(msgs) != 2 || msgs[1].Status != "failed" {
		t.Fatal("failure state not persisted")
	}
}

// TestSettingsSecretsAndReopen 覆盖密钥不回显、空密钥保留旧值、重启后仍生效，
// 以及非法服务地址被拒绝。
func TestSettingsSecretsAndReopen(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	app, err := bootstrap.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	s := cfg.Settings
	s.LLM.APIKey = "private-key"
	s.Speech.APIKey = "speech-secret"
	w := request(t, app, "PUT", "/settings", s)
	if w.Code != 200 || strings.Contains(w.Body.String(), "private-key") || strings.Contains(w.Body.String(), "speech-secret") {
		t.Fatal("settings response leaked a secret")
	}
	s.LLM.APIKey = ""
	s.Speech.APIKey = ""
	s.LLM.Model = "changed"
	request(t, app, "PUT", "/settings", s)
	app.Close()
	reopened, err := bootstrap.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	var row struct{ Value string }
	if err := reopened.DB.Table("records").Where("id = ?", 1).Take(&row).Error; err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(row.Value, "private-key") {
		t.Fatal("blank API key did not preserve secret")
	}
	w = request(t, reopened, "GET", "/settings", nil)
	if !strings.Contains(w.Body.String(), `"model":"changed"`) || strings.Contains(w.Body.String(), "private-key") {
		t.Fatal(w.Body.String())
	}
	invalid := s
	invalid.LLM.BaseURL = "file:///etc/passwd"
	if request(t, reopened, "PUT", "/settings", invalid).Code != 400 {
		t.Fatal("invalid URL accepted")
	}
}

// TestRejectCrossOriginAndRebinding 覆盖跨站 Origin、域名重绑定与缺少客户端
// 标识的写请求都被拒绝。
func TestRejectCrossOriginAndRebinding(t *testing.T) {
	app := newApp(t)
	for _, test := range []struct{ host, origin, client string }{{"127.0.0.1:12393", "https://evil.example", "1"}, {"attacker.example:12393", "", "1"}, {"127.0.0.1:12393", "", ""}} {
		r := httptest.NewRequest("POST", "http://"+test.host+"/api/v1/conversations", strings.NewReader(`{"character_id":"mao"}`))
		r.Header.Set("Origin", test.origin)
		r.Header.Set("X-Studio-Client", test.client)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		app.Router.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatalf("unsafe request accepted: %+v: %s", test, w.Body)
		}
	}
}

// archive 在内存中构造 ZIP 包，供模型导入用例复用。
func archive(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var out bytes.Buffer
	z := zip.NewWriter(&out)
	for name, data := range files {
		f, err := z.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(f, data)
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// upload 以 multipart 表单提交模型包。
func upload(t *testing.T, app *bootstrap.App, data []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	part, _ := mw.CreateFormFile("file", "model.zip")
	part.Write(data)
	mw.Close()
	r := httptest.NewRequest("POST", "http://127.0.0.1:12393/api/v1/characters/import", &body)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	r.Header.Set("X-Studio-Client", "1")
	w := httptest.NewRecorder()
	app.Router.ServeHTTP(w, r)
	return w
}

// TestModelImportAndZipTraversal 覆盖模型包导入成功，以及 ZIP 路径穿越、
// 内部路径逃逸与缺少 moc 文件等异常被拒绝。
func TestModelImportAndZipTraversal(t *testing.T) {
	app := newApp(t)
	good := map[string]string{"sample/model.model3.json": `{"Version":3,"FileReferences":{"Moc":"model.moc3","Textures":["texture.png"]}}`, "sample/model.moc3": "moc", "sample/texture.png": "png"}
	result := decode[model.Character](t, upload(t, app, archive(t, good)))
	if !strings.HasPrefix(result.ModelPath, "/models/") {
		t.Fatal(result)
	}
	for _, bad := range []map[string]string{{"../escape.txt": "bad"}, {"folder/model.model3.json": `{"FileReferences":{"Moc":"../../escape.moc3"}}`}, {"model.model3.json": `{"FileReferences":{"Moc":"missing.moc3"}}`}} {
		if upload(t, app, archive(t, bad)).Code != 400 {
			t.Fatal("unsafe or incomplete archive accepted")
		}
	}
	if _, err := os.Stat(filepath.Join(app.Config.DataDir, "escape.txt")); !os.IsNotExist(err) {
		t.Fatal("ZIP escaped destination")
	}
}

// TestStreamCancellation 覆盖客户端断开后上游请求被取消、回复标记为 interrupted。
func TestStreamCancellation(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		chunk(w, map[string]any{"role": "assistant", "content": "partial"}, nil)
		close(started)
		<-r.Context().Done()
		close(cancelled)
	}))
	defer up.Close()
	app := newApp(t)
	configure(t, app, up.URL, false)
	conv := conversation(t, app)
	server := httptest.NewServer(app.Router)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "POST", server.URL+"/api/v1/conversations/"+conv.ID+"/messages", strings.NewReader(`{"text":"cancel test"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Studio-Client", "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	<-started
	cancel()
	resp.Body.Close()
	select {
	case <-cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("upstream not cancelled")
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		var msg model.Message
		app.DB.Where("conversation_id = ? AND role = ?", conv.ID, "assistant").First(&msg)
		if msg.Status == "interrupted" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("interrupted response not persisted")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestSpeechProxy 覆盖语音转写与合成的后端代理及密钥转发。
func TestSpeechProxy(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer speech-test" {
			t.Error("speech key was not forwarded")
		}
		switch r.URL.Path {
		case "/v1/audio/transcriptions":
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Error(err)
				return
			}
			defer r.MultipartForm.RemoveAll()
			if r.FormValue("model") != "whisper-1" {
				t.Error("wrong ASR model")
			}
			file, _, err := r.FormFile("file")
			if err != nil {
				t.Error(err)
				return
			}
			defer file.Close()
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"text":"识别测试"}`)
		case "/v1/audio/speech":
			var req struct{ Input, Model, Voice string }
			if json.NewDecoder(r.Body).Decode(&req) != nil || req.Input != "朗读测试" || req.Model != "tts-1" {
				t.Error("invalid TTS payload")
			}
			w.Header().Set("Content-Type", "audio/mpeg")
			io.WriteString(w, "test-audio")
		default:
			http.NotFound(w, r)
		}
	}))
	defer up.Close()
	app := newApp(t)
	cfg := config.Defaults().Settings
	cfg.Speech.BaseURL = up.URL + "/v1"
	cfg.Speech.APIKey = "speech-test"
	cfg.Speech.Mode = "api"
	if request(t, app, "PUT", "/settings", cfg).Code != 200 {
		t.Fatal("speech settings rejected")
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, _ := writer.CreateFormFile("file", "test.webm")
	part.Write([]byte("audio"))
	writer.Close()
	r := httptest.NewRequest("POST", "http://127.0.0.1/api/v1/speech/transcribe", &body)
	r.Header.Set("X-Studio-Client", "1")
	r.Header.Set("Content-Type", writer.FormDataContentType())
	w := httptest.NewRecorder()
	app.Router.ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "识别测试") {
		t.Fatal(w.Body.String())
	}
	w = request(t, app, "POST", "/speech/synthesize", map[string]string{"text": "朗读测试"})
	if w.Code != 200 || w.Body.String() != "test-audio" || w.Header().Get("Content-Type") != "audio/mpeg" {
		t.Fatal(w.Body.String())
	}
}

// TestConcurrentGenerationRejected 覆盖同一会话并发生成、以及生成过程中删除会话被拒绝。
func TestConcurrentGenerationRejected(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		chunk(w, map[string]any{"role": "assistant", "content": "one"}, nil)
		close(started)
		<-release
		chunk(w, map[string]any{}, "stop")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer up.Close()
	app := newApp(t)
	configure(t, app, up.URL, false)
	conv := conversation(t, app)
	done := make(chan struct{})
	go func() {
		request(t, app, "POST", "/conversations/"+conv.ID+"/messages", map[string]string{"text": "first"})
		close(done)
	}()
	<-started
	second := request(t, app, "POST", "/conversations/"+conv.ID+"/messages", map[string]string{"text": "second"})
	if !strings.Contains(second.Body.String(), "正在生成回复") {
		t.Error("concurrent generation was not rejected")
	}
	if w := request(t, app, "DELETE", "/conversations/"+conv.ID, nil); w.Code != 409 {
		t.Error("active conversation deletion was not rejected")
	}
	close(release)
	<-done
	msgs := decode[[]model.Message](t, request(t, app, "GET", "/conversations/"+conv.ID+"/messages", nil))
	if len(msgs) != 2 {
		t.Fatalf("concurrent request wrote %d messages", len(msgs))
	}
}
