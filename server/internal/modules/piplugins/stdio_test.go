// stdio_test.go 覆盖本地 stdio MCP 的桌面授权、参数绑定与撤销行为。
package piplugins

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestPluginStdioGrantBindsCommandAndSettings(t *testing.T) {
	desktop := false
	m := New(t.TempDir(), func() bool { return desktop })
	router := registryRouter(m)
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	manifest, err := writer.Create("manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.WriteString(manifest, `{
		"schemaVersion": 1, "id": "fixture.stdio", "name": "Test MCP", "version": "1.0.0",
		"permissions": ["mcp.server.local"], "main": "main.js",
		"contributes": {"mcpServers": [
			{"id": "local", "transport": "stdio", "command": "go", "args": ["version"],
			 "env": {"MCP_VALUE": {"setting": "auth.token"}}},
			{"id": "escape", "transport": "stdio", "command": "../other"}
		]}
	}`)
	if err != nil {
		t.Fatal(err)
	}
	main, err := writer.Create("main.js")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(main, "module.exports = {}"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	plugin := readResult[Plugin](t, uploadPlugin(t, router, archive.Bytes()))
	if plugin.Enabled || len(plugin.Supported) != 1 || plugin.Supported[0] != "mcpStdio" {
		t.Fatalf("incorrect stdio capabilities: %#v", plugin)
	}
	endpoint := "/fixture.stdio/stdio"
	approve := func(body string) int {
		return requestPlugin(router, "PUT", endpoint+"/local", "application/json", strings.NewReader(body), true).Code
	}
	body := `{"approved":true,"environment":{"auth.token":"fixture-invalid-secret"}}`
	if code := approve(body); code != http.StatusConflict {
		t.Fatalf("headless grant allowed: %d", code)
	}
	desktop = true
	if code := approve(`{"approved":true}`); code != http.StatusBadRequest {
		t.Fatalf("missing credentials: %d", code)
	}
	if code := approve(body); code != http.StatusOK {
		t.Fatalf("grant failed: %d", code)
	}
	if len(m.ApprovedStdio()) != 0 {
		t.Fatal("disabled package exposed approved command")
	}
	readResult[Plugin](t, requestPlugin(router, "PUT", "/fixture.stdio", "application/json", strings.NewReader(`{"enabled":true}`), true))
	items := m.ApprovedStdio()
	if len(items) != 1 || len(items[0].Args) != 1 || items[0].Args[0] != "version" ||
		items[0].Env["MCP_VALUE"] != "fixture-invalid-secret" || len(items[0].Redact) != 1 {
		t.Fatalf("wrong worker data: %d entries", len(items))
	}
	viewResponse := requestPlugin(router, "GET", endpoint, "", nil, true)
	view := readResult[[]stdioView](t, viewResponse)
	if len(view) != 1 || !view[0].Approved || strings.Contains(viewResponse.Body.String(), "fixture-invalid-secret") {
		t.Fatal("grant view returned incorrect metadata")
	}
	if code := approve(`{"approved":false}`); code != http.StatusOK || len(m.ApprovedStdio()) != 0 {
		t.Fatalf("did not revoke command: %d", code)
	}
}
