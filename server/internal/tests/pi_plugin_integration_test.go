package tests

import (
	"archive/zip"
	"bytes"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"server/internal/bootstrap"
	"server/internal/config"
	"server/internal/model"
	"server/internal/modules/piplugins"
)

func TestCodingPluginEnableActivatesSkillAndTheme(t *testing.T) {
	runtime, err := filepath.Abs("../../pi-runtime")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(runtime, "node_modules", "@earendil-works", "pi-coding-agent")); err != nil {
		t.Skip("Pi runtime dependencies unavailable")
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("Node.js unavailable")
	}
	var enabled atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		payload, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		hasSkillTool := bytes.Contains(payload, []byte(`"name":"plugin_skill"`))
		if hasSkillTool != enabled.Load() || bytes.Contains(payload, []byte("Prepare the fixture release checklist.")) {
			t.Error("plugin activation did not match current grants")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		chunk(w, map[string]string{"role": "assistant", "content": "完成"}, nil)
		chunk(w, map[string]string{}, "stop")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	cfg := config.Defaults()
	cfg.DataDir, cfg.PiRuntimeDir = t.TempDir(), runtime
	app, err := bootstrap.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	configure(t, app, upstream.URL, true)
	var packageData bytes.Buffer
	archive := zip.NewWriter(&packageData)
	for name, body := range map[string]string{
		"manifest.json": `{
			"schemaVersion":1,"id":"fixture.tools","name":"Fixture tools","version":"1.0.0","main":"main.js",
			"permissions":["agent.prompt.inject","ui.theme"],
			"contributes":{"skills":[{"path":"skills/release.md"}],"themes":[{"id":"sky","label":"Sky","path":"sky.css","base":"dark"}]}
		}`,
		"main.js":           "throw new Error('This imported JavaScript must never execute');",
		"skills/release.md": "---\nname: Release\n---\nPrepare the fixture release checklist.",
		"sky.css":           ":root { --ds-bg-primary: #002144; }",
	} {
		entry, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(entry, body); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	var data bytes.Buffer
	multipartWriter := multipart.NewWriter(&data)
	part, err := multipartWriter.CreateFormFile("file", "fixture.piplug")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := packageData.WriteTo(part); err != nil {
		t.Fatal(err)
	}
	if err := multipartWriter.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", "http://127.0.0.1:12393/api/v1/coding/plugins/import", &data)
	req.Header.Set("Content-Type", multipartWriter.FormDataContentType())
	req.Header.Set("X-Studio-Client", "1")
	result := httptest.NewRecorder()
	app.Router.ServeHTTP(result, req)
	plugin := decode[piplugins.Plugin](t, result)
	if plugin.Enabled || plugin.ID != "fixture.tools" {
		t.Fatalf("import must await enable: %#v", plugin)
	}
	project := decode[model.CodingProject](t, request(t, app, "POST", "/coding/projects", map[string]string{"path": t.TempDir()}))
	session := decode[model.CodingSession](t, request(t, app, "POST", "/coding/projects/"+project.ID+"/sessions", nil))
	for _, active := range []bool{false, true, false} {
		changed := decode[piplugins.Plugin](t, request(t, app, "PUT", "/coding/plugins/"+plugin.ID, map[string]bool{"enabled": active}))
		if changed.Enabled != active {
			t.Fatalf("unexpected enabled state: %#v", changed)
		}
		enabled.Store(active)
		themes := decode[[]struct {
			ID     string
			Tokens map[string]string
		}](t, request(t, app, "GET", "/coding/plugins/themes", nil))
		if (len(themes) == 1) != active || active && (themes[0].ID != "fixture.tools/sky" || themes[0].Tokens["--code-surface"] != "#002144") {
			t.Fatalf("theme did not reflect enabled state: %#v", themes)
		}
		w := request(t, app, "POST", "/coding/sessions/"+session.ID+"/messages", map[string]string{"text": "处理发布流程", "mode": "plan"})
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"complete"`) {
			t.Fatalf("coding turn failed with enabled=%v: %d %s", active, w.Code, w.Body)
		}
	}
}
