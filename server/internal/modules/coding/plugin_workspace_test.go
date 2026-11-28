// plugin_workspace_test.go 覆盖插件工作区读取的项目与清单范围限制。
package coding

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"server/internal/modules/piplugins"

	"github.com/gin-gonic/gin"
)

func TestPluginWorkspaceReadRespectsCurrentProjectAndManifestScope(t *testing.T) {
	m, _, project, session := orchestrationTestRouter(t, "")
	for _, directory := range []string{"docs", "private"} {
		if err := os.Mkdir(filepath.Join(project.Path, directory), 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, file := range []string{"docs/notes.md", "docs/.env", "docs/id_ed25519", "private/notes.md"} {
		if err := os.WriteFile(filepath.Join(project.Path, filepath.FromSlash(file)), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	var item piplugins.Installation
	item.Manifest.FS.Read.Root = "workspace"
	item.Manifest.FS.Read.Scope = []string{"docs/**"}
	selection := piplugins.HostWorkspaceContext{ProjectID: project.ID, SessionID: session.ID}
	call := func(method string, input any) (any, error) {
		args, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		return m.PluginWorkspaceCall(context.Background(), item, selection, method, args)
	}
	if result, err := call("fs.readText", "docs/notes.md"); err != nil || result != "fixture" {
		t.Fatalf("scoped file: %v %v", result, err)
	}
	for _, file := range []string{"private/notes.md", "../notes.md", "docs/.env", "docs/id_ed25519"} {
		if _, err := call("fs.readText", file); err == nil {
			t.Errorf("plugin could read %s", file)
		}
	}
	for path, name := range map[string]string{".": "docs", "docs": "notes.md"} {
		result, err := call("fs.list", path)
		entries, ok := result.([]gin.H)
		if err != nil || !ok || len(entries) != 1 || entries[0]["name"] != name {
			t.Fatalf("unexpected files listed in %s: %v %v", path, result, err)
		}
	}
	if _, err := call("fs.stat", gin.H{"path": "docs/notes.md", "workspacePath": t.TempDir()}); err == nil {
		t.Fatal("plugin could override workspace selection")
	}
	if _, err := call("session.listMessages", gin.H{"sessionId": "other-session"}); err == nil {
		t.Fatal("plugin could override session selection")
	}
}
