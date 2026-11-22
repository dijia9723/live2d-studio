package tests

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"server/internal/bootstrap"
	"server/internal/config"
	"server/internal/model"
)

func TestCodingProjectFileRevision(t *testing.T) {
	app := newApp(t)
	dir := t.TempDir()
	for path, content := range map[string]string{"readme.md": "original", ".env": "PRIVATE=value"} {
		if err := os.WriteFile(filepath.Join(dir, path), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	project := decode[model.CodingProject](t, request(t, app, "POST", "/coding/projects", map[string]string{"path": dir}))
	again := decode[model.CodingProject](t, request(t, app, "POST", "/coding/projects", map[string]string{"path": dir}))
	if project.ID != again.ID {
		t.Fatal("duplicate project")
	}
	path := "/coding/projects/" + project.ID + "/file"
	var original = decode[map[string]string](t, request(t, app, "GET", path+"?path=readme.md", nil))
	saved := decode[map[string]string](t, request(t, app, "PUT", path, map[string]string{
		"path": "readme.md", "content": "new value", "revision": original["revision"],
	}))
	if saved["content"] != "new value" || saved["revision"] == original["revision"] {
		t.Fatalf("invalid file response: %#v", saved)
	}
	if w := request(t, app, "PUT", path, map[string]string{"path": "readme.md", "content": "stale", "revision": original["revision"]}); w.Code != 409 {
		t.Fatalf("stale write: %d %s", w.Code, w.Body)
	}
	for _, name := range []string{"../external", ".env"} {
		if w := request(t, app, "GET", path+"?path="+name, nil); w.Code != 400 {
			t.Fatalf("blocked path %s: %d", name, w.Code)
		}
	}
	other := httptest.NewRequest("GET", "http://127.0.0.1:12393/api/v1"+path+"?path=readme.md", nil)
	other.Header.Set("X-Studio-Client", "1")
	other.Header.Set("Origin", "http://127.0.0.1:4999")
	response := httptest.NewRecorder()
	app.Router.ServeHTTP(response, other)
	if response.Code != 403 {
		t.Fatalf("cross-origin read: %d", response.Code)
	}
	results := decode[struct{ Files []string }](t, request(t, app, "GET", "/coding/projects/"+project.ID+"/search?q=README", nil))
	if !slices.Equal(results.Files, []string{"readme.md"}) {
		t.Fatalf("project search: %v", results.Files)
	}
	results = decode[struct{ Files []string }](t, request(t, app, "GET", "/coding/projects/"+project.ID+"/search?q=.env", nil))
	if len(results.Files) != 0 {
		t.Fatalf("project search exposed ignored files: %v", results.Files)
	}
}

func TestCodingGitChangesStayInProject(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("Git unavailable")
	}
	dir := t.TempDir()
	projectDir := filepath.Join(dir, "project")
	if err := os.Mkdir(projectDir, 0700); err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s %v", args, out, err)
		}
	}
	write := func(path, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(path)), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	git("init")
	write("project/readme.txt", "before\n")
	write("sibling.txt", "before\n")
	git("add", "--", "project/readme.txt", "sibling.txt")
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Initial")
	git("config", "filter.fixture.clean", "exit 42")
	git("config", "filter.fixture.required", "true")
	write("project/.gitattributes", "*.txt filter=fixture\n")
	write("project/readme.txt", "change inside project\n")
	write("sibling.txt", "outside project\n")
	app := newApp(t)
	project := decode[model.CodingProject](t, request(t, app, "POST", "/coding/projects", map[string]string{"path": projectDir}))
	var changes = decode[struct {
		Available bool
		Status    string
		Diff      string
	}](t, request(t, app, "GET", "/coding/projects/"+project.ID+"/changes", nil))
	if !changes.Available || !strings.Contains(changes.Diff, "+change inside project") ||
		strings.Contains(changes.Status+changes.Diff, "sibling.txt") {
		t.Fatalf("invalid project changes: %#v", changes)
	}
}

func TestCodingBundledPlugins(t *testing.T) {
	app := newApp(t)
	dir := t.TempDir()
	project := decode[model.CodingProject](t, request(t, app, "POST", "/coding/projects", map[string]string{"path": dir}))
	projectURL := "/coding/projects/" + project.ID
	action := projectURL + "/files/action"
	for _, entry := range []map[string]string{
		{"action": "directory", "path": "docs"},
		{"action": "file", "path": "docs/new.txt"},
		{"action": "move", "path": "docs/new.txt", "target": "docs/moved.txt"},
	} {
		if result := request(t, app, "POST", action, entry); result.Code != 200 {
			t.Fatalf("file action %v: %d %s", entry, result.Code, result.Body)
		}
	}
	if result := request(t, app, "POST", action, map[string]string{"action": "remove", "path": "docs"}); result.Code != 400 {
		t.Fatalf("expected a refusal to remove a nonempty directory: %d", result.Code)
	}
	if err := os.WriteFile(filepath.Join(dir, "preview.pdf"), []byte("%PDF-1.7 fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	preview := projectURL + "/preview?path=preview.pdf"
	if result := request(t, app, "GET", preview, nil); result.Code != 200 || result.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("PDF preview: %d %s", result.Code, result.Body)
	}
	if result := request(t, app, "PUT", "/coding/plugins/pi.file-manager", map[string]bool{"enabled": false}); result.Code != 200 {
		t.Fatalf("disable bundled plugin: %d %s", result.Code, result.Body)
	}
	if result := request(t, app, "GET", preview, nil); result.Code != 409 {
		t.Fatalf("disabled plugin preview: %d", result.Code)
	}

	path := "/coding/enhancements"
	options := decode[model.CodingEnhancements](t, request(t, app, "GET", path, nil))
	if !options.Titles || options.Rewrite || options.Recall {
		t.Fatalf("unexpected enhancement defaults: %#v", options)
	}
	options.Rewrite = true
	decode[model.CodingEnhancements](t, request(t, app, "PUT", path, options))
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"id":"fixture","object":"chat.completion","model":"mock","choices":[{"index":0,"message":{"role":"assistant","content":"强化后的提示词"},"finish_reason":"stop"}]}`)
	}))
	defer upstream.Close()
	configure(t, app, upstream.URL, true)
	rewrite := decode[map[string]string](t, request(t, app, "POST", path+"/rewrite", map[string]string{"text": "整理项目说明"}))
	if rewrite["text"] != "强化后的提示词" {
		t.Fatalf("unexpected prompt rewrite: %#v", rewrite)
	}
	memoryPath := path + "/memory"
	memory := decode[model.CodingMemory](t, request(t, app, "POST", memoryPath, map[string]string{
		"project_id": project.ID, "content": "项目始终执行单元测试",
	}))
	memory = decode[model.CodingMemory](t, request(t, app, "POST", memoryPath, map[string]string{
		"id": memory.ID, "project_id": project.ID, "content": "项目始终执行 Go 单元测试",
	}))
	own := decode[[]model.CodingMemory](t, request(t, app, "GET", memoryPath, nil))
	scoped := decode[[]model.CodingMemory](t, request(t, app, "GET", memoryPath+"?project="+project.ID, nil))
	if len(own) != 0 || len(scoped) != 1 || scoped[0].Content != "项目始终执行 Go 单元测试" {
		t.Fatalf("memory scope: %#v %#v, edited: %#v", own, scoped, memory)
	}
}

func TestCodingPiWorkflow(t *testing.T) {
	runtimeDir, err := filepath.Abs("../../pi-runtime")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(runtimeDir, "node_modules", "@earendil-works", "pi-coding-agent")); err != nil {
		t.Skip("Pi runtime dependencies unavailable")
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("Node.js unavailable")
	}
	revision := fmt.Sprintf("%x", sha256.Sum256([]byte("original\n")))
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Messages []struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			}
			Tools []struct{ Function struct{ Name string } }
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("missing model credential")
		}
		canWrite := slices.ContainsFunc(payload.Tools, func(tool struct{ Function struct{ Name string } }) bool { return tool.Function.Name == "write_file" })
		steps := 0
		previousUser := false
		for _, message := range payload.Messages {
			if message.Role == "user" {
				switch {
				case strings.Contains(string(message.Content), "处理 readme.md"):
					previousUser = true
				case strings.Contains(string(message.Content), "继续分支") && !previousUser:
					t.Error("Pi provider did not receive the forked conversation context")
				}
				steps = 0
			}
			if message.Role == "tool" {
				steps++
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		var tool string
		var args map[string]string
		switch {
		case steps == 0:
			tool, args = "read_file", map[string]string{"path": "readme.md"}
		case steps == 1 && canWrite:
			tool, args = "write_file", map[string]string{"path": "readme.md", "content": "updated by Pi\n", "revision": revision}
		}
		if tool != "" {
			encoded, _ := json.Marshal(args)
			chunk(w, map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{
				"index": 0, "id": fmt.Sprintf("call_%d", steps), "type": "function", "function": map[string]string{"name": tool, "arguments": string(encoded)},
			}}}, nil)
			chunk(w, map[string]any{}, "tool_calls")
		} else {
			chunk(w, map[string]any{"role": "assistant", "content": "完成"}, nil)
			chunk(w, map[string]any{}, "stop")
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	cfg := config.Defaults()
	cfg.DataDir, cfg.PiRuntimeDir = t.TempDir(), runtimeDir
	app, err := bootstrap.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	configure(t, app, upstream.URL, true)
	dir := t.TempDir()
	filename := filepath.Join(dir, "readme.md")
	if err := os.WriteFile(filename, []byte("original\n"), 0600); err != nil {
		t.Fatal(err)
	}
	project := decode[model.CodingProject](t, request(t, app, "POST", "/coding/projects", map[string]string{"path": dir}))
	session := decode[model.CodingSession](t, request(t, app, "POST", "/coding/projects/"+project.ID+"/sessions", nil))
	path := "/coding/sessions/" + session.ID + "/messages"
	for _, mode := range []string{"plan", "agent"} {
		w := request(t, app, "POST", path, map[string]string{"text": "处理 readme.md", "mode": mode})
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"complete"`) || !strings.Contains(w.Body.String(), `"type":"tool"`) {
			t.Fatalf("Pi %s: %d %s", mode, w.Code, w.Body)
		}
		content, err := os.ReadFile(filename)
		want := "original\n"
		if mode == "agent" {
			want = "updated by Pi\n"
		}
		if err != nil || string(content) != want {
			t.Fatalf("Pi %s: file %q, %v", mode, content, err)
		}
	}
	messages := decode[[]model.CodingMessage](t, request(t, app, "GET", path, nil))
	if len(messages) != 4 || messages[3].Content != "完成" || len(messages[3].Tools) != 2 {
		t.Fatalf("missing persisted messages: %#v", messages)
	}
	sessionPath := "/coding/sessions/" + session.ID
	renamed := decode[model.CodingSession](t, request(t, app, "PUT", sessionPath, map[string]string{"title": "原始会话"}))
	if renamed.Title != "原始会话" {
		t.Fatalf("unexpected title: %q", renamed.Title)
	}
	child := decode[model.CodingSession](t, request(t, app, "POST", sessionPath+"/fork", nil))
	if child.ID == session.ID || child.ProjectID != project.ID || child.Title != "原始会话（分支）" {
		t.Fatalf("invalid session fork: %#v", child)
	}
	childPath := "/coding/sessions/" + child.ID + "/messages"
	childMessages := decode[[]model.CodingMessage](t, request(t, app, "GET", childPath, nil))
	if len(childMessages) != 4 || childMessages[3].ID == messages[3].ID || len(childMessages[3].Tools) != 2 {
		t.Fatalf("invalid forked messages: %#v", childMessages)
	}
	archived := decode[model.CodingSession](t, request(t, app, "PUT", sessionPath, map[string]bool{"archived": true}))
	if !archived.Archived {
		t.Fatal("source session was not archived")
	}
	if result := request(t, app, "POST", path, map[string]string{"text": "继续", "mode": "plan"}); result.Code != 409 {
		t.Fatalf("archived session allowed prompts: %d %s", result.Code, result.Body)
	}
	if result := request(t, app, "POST", childPath, map[string]string{"text": "继续分支", "mode": "plan"}); result.Code != 200 ||
		!strings.Contains(result.Body.String(), `"status":"complete"`) {
		t.Fatalf("fork could not continue: %d %s", result.Code, result.Body)
	}
	restored := decode[model.CodingSession](t, request(t, app, "PUT", sessionPath, map[string]bool{"archived": false}))
	originalMessages := decode[[]model.CodingMessage](t, request(t, app, "GET", path, nil))
	if restored.Archived || len(originalMessages) != 4 {
		t.Fatalf("source session changed after fork: %#v, %d messages", restored, len(originalMessages))
	}
}
