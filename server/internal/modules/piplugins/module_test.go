package piplugins

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

type fixtureEntry struct {
	path string
	data string
	mode os.FileMode
}

func fixturePackage(t *testing.T, id, version string, extra ...fixtureEntry) []byte {
	t.Helper()
	manifest := fmt.Sprintf(`{"schemaVersion":1,"id":%q,"name":"Example","version":%q,"main":"main.js","permissions":["agent.prompt.inject"],"contributes":{"skills":["skills/notes.md"]}}`, id, version)
	entries := append([]fixtureEntry{
		{path: "manifest.json", data: manifest},
		{path: "main.js", data: "module.exports = {}"},
		{path: "skills/notes.md", data: "---\nname: notes\n---\nUse project notes."},
	}, extra...)
	return zipFixture(t, entries)
}

func zipFixture(t *testing.T, entries []fixtureEntry) []byte {
	t.Helper()
	var b bytes.Buffer
	w := zip.NewWriter(&b)
	for _, e := range entries {
		header := &zip.FileHeader{Name: e.path, Method: zip.Deflate}
		header.SetMode(0600 | e.mode)
		file, err := w.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(file, e.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestTrustedExtensionsRequireLocalDesktopGrantAndMatchInstalledBytes(t *testing.T) {
	m := New(t.TempDir(), func() bool { return true })
	router := registryRouter(m)
	const source = `export default function extension(pi) {}`
	archive := zipFixture(t, []fixtureEntry{
		{path: "manifest.json", data: `{"schemaVersion":1,"id":"fixture.trusted","name":"Trusted","version":"1.0.0","main":"main.js","permissions":["agent.extension"],"contributes":{"agentExtensions":["ext/index.mjs"]}}`},
		{path: "main.js", data: "module.exports = {}"},
		{path: "ext/index.mjs", data: source},
	})
	if _, err := m.install(archive, "marketplace", "fixture.trusted", "1.0.0"); err == nil {
		t.Fatal("marketplace package with native extension was accepted")
	}
	readResult[Plugin](t, uploadPlugin(t, router, archive))
	readResult[Plugin](t, requestPlugin(router, "PUT", "/fixture.trusted", "application/json", strings.NewReader(`{"enabled":true}`), true))
	const route = "/fixture.trusted/trusted-extension"
	const grant = `{"approved":true,"version":"1.0.0"}`
	if reply := requestPlugin(router, "PUT", route, "application/json", strings.NewReader(grant), true); reply.Code != http.StatusForbidden {
		t.Fatalf("grant outside the desktop returned %d", reply.Code)
	}
	req := httptest.NewRequest("PUT", "/api/v1/coding/plugins"+route, strings.NewReader(grant))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://wails.localhost")
	req.Header.Set("X-Studio-Client", "1")
	reply := httptest.NewRecorder()
	router.ServeHTTP(reply, req)
	if state := readResult[trustedExtensionStatus](t, reply); !state.Approved || !state.Ready {
		t.Fatalf("desktop grant was not attached: %#v", state)
	}
	paths, cleanup, err := m.StageTrustedExtensions(context.Background())
	defer cleanup()
	if err != nil || len(paths) != 1 {
		t.Fatalf("stage trusted extension: %v %v", paths, err)
	}
	installed, err := m.EnabledInstallations()
	if err != nil || len(installed) != 1 {
		t.Fatalf("read enabled installations: %v %v", installed, err)
	}
	if err := os.WriteFile(filepath.Join(installed[0].Root, "ext", "index.mjs"), []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(paths[0]); err != nil || string(data) != source {
		t.Fatalf("prepared extension changed with installation: %q %v", data, err)
	}
	modified, cleanModified, err := m.StageTrustedExtensions(context.Background())
	defer cleanModified()
	if len(modified) != 0 || err != nil {
		t.Fatalf("modified extension was staged: %v %v", modified, err)
	}
}

func registryRouter(m *Module) *gin.Engine {
	r := gin.New()
	m.Register(r.Group("/api/v1"))
	return r
}

func requestPlugin(r *gin.Engine, method, path, contentType string, body io.Reader, trusted bool) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/api/v1/coding/plugins"+path, body)
	req.Header.Set("Content-Type", contentType)
	if trusted {
		req.Header.Set("X-Studio-Client", "1")
	}
	out := httptest.NewRecorder()
	r.ServeHTTP(out, req)
	return out
}

func readResult[T any](t *testing.T, response *httptest.ResponseRecorder) T {
	t.Helper()
	var out struct {
		Data T `json:"data"`
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &out) != nil {
		t.Fatalf("unexpected response %d: %s", response.Code, response.Body.String())
	}
	return out.Data
}

func uploadPlugin(t *testing.T, router *gin.Engine, content []byte) *httptest.ResponseRecorder {
	t.Helper()
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	file, err := w.CreateFormFile("file", "example.piplug")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return requestPlugin(router, "POST", "/import", w.FormDataContentType(), &b, true)
}

func TestPluginRegistryLifecycle(t *testing.T) {
	dataDir := t.TempDir()
	m := New(dataDir, nil)
	r := registryRouter(m)
	if result := requestPlugin(r, "GET", "", "", nil, false); result.Code != 403 {
		t.Fatalf("missing workspace header returned %d", result.Code)
	}
	initial := readResult[[]Plugin](t, requestPlugin(r, "GET", "", "", nil, true))
	if len(initial) != 3 || !initial[0].Enabled {
		t.Fatalf("bad native plugin defaults: %#v", initial)
	}
	readResult[Plugin](t, requestPlugin(r, "PUT", "/pi.browser", "application/json", strings.NewReader(`{"enabled":false}`), true))
	if New(dataDir, nil).Enabled("pi.browser") {
		t.Fatal("native plugin setting did not persist")
	}
	archive := fixturePackage(t, "demo.notes", "1.0.0")
	imported := readResult[Plugin](t, uploadPlugin(t, r, archive))
	if imported.Enabled || imported.Source != "local" || !slices.Equal(imported.Supported, []string{"skills"}) {
		t.Fatalf("unexpected imported plugin: %#v", imported)
	}
	if installs, err := m.EnabledInstallations(); err != nil || len(installs) != 0 {
		t.Fatalf("imported plugin was available without activation: %#v %v", installs, err)
	}
	enabled := readResult[Plugin](t, requestPlugin(r, "PUT", "/demo.notes", "application/json", strings.NewReader(`{"enabled":true}`), true))
	if !enabled.Enabled {
		t.Fatal("plugin did not enable")
	}
	if installs, err := New(dataDir, nil).EnabledInstallations(); err != nil || len(installs) != 1 || installs[0].Manifest.ID != "demo.notes" {
		t.Fatalf("plugin did not survive restart: %#v %v", installs, err)
	}
	upgraded := readResult[Plugin](t, uploadPlugin(t, r, fixturePackage(t, "demo.notes", "1.1.0")))
	if upgraded.Enabled || upgraded.Version != "1.1.0" {
		t.Fatalf("upgrade bypassed permission review: %#v", upgraded)
	}
	readResult[any](t, requestPlugin(r, "DELETE", "/demo.notes", "", nil, true))
	final := readResult[[]Plugin](t, requestPlugin(r, "GET", "", "", nil, true))
	if len(final) != 3 || final[0].Enabled {
		t.Fatalf("unexpected state after plugin removal: %#v", final)
	}
}

func TestRejectUnsafePackagePathsAndTypes(t *testing.T) {
	m := New(t.TempDir(), nil)
	r := registryRouter(m)
	for _, entry := range []fixtureEntry{
		{path: "../outside.txt", data: "no"},
		{path: "docs/../file", data: "no"},
		{path: "docs/AUX.md", data: "no"},
		{path: "docs/folder. /content", data: "no"},
		{path: "docs/notes.md:secret", data: "no"},
		{path: "SKILLS/duplicate.md", data: "no"},
		{path: "main.js", data: "no"},
		{path: "symlink", data: "../outside", mode: os.ModeSymlink},
	} {
		t.Run(entry.path, func(t *testing.T) {
			if result := uploadPlugin(t, r, fixturePackage(t, "demo.notes", "1.0.0", entry)); result.Code != 400 {
				t.Fatalf("invalid package returned %d: %s", result.Code, result.Body.String())
			}
		})
	}
	if result := uploadPlugin(t, r, fixturePackage(t, "pi.browser", "1.0.0")); result.Code != 400 {
		t.Fatalf("plugin replaced built-in browser: %d", result.Code)
	}
	entries, err := os.ReadDir(m.root)
	if err != nil || len(entries) != 0 {
		t.Fatalf("rejected packages left files behind: %#v %v", entries, err)
	}
}

type fixtureTransport func(*http.Request) (*http.Response, error)

func (f fixtureTransport) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestPluginMarketplaceDownloadsVerifiedMirror(t *testing.T) {
	m := New(t.TempDir(), nil)
	archive := fixturePackage(t, "demo.notes", "1.10.0")
	sum := fmt.Sprintf("%x", sha256.Sum256(archive))
	catalog := fmt.Sprintf(`{"schemaVersion":2,"plugins":[{"id":"demo.notes","name":"Notes","versions":[{"version":"1.2.0","shasum":%q,"sizeBytes":%d,"url":"packages/old.piplug"},{"version":"1.10.0","shasum":%q,"sizeBytes":%d,"url":"packages/latest.piplug"},{"version":"2.0.0","yanked":true,"shasum":%q,"sizeBytes":%d,"url":"packages/beta.piplug"}]}]}`, sum, len(archive), sum, len(archive), sum, len(archive))
	mirrorCalls := 0
	m.client.Transport = fixtureTransport(func(req *http.Request) (*http.Response, error) {
		var data []byte
		switch req.URL.String() {
		case officialCatalog:
			data = []byte(catalog)
		case "https://plugins.aiuo.net/packages/latest.piplug":
			data = []byte("<html>not a plug-in artifact</html>")
		case "https://cnb.cool/aixk/pi-desktop-plugins/-/git/raw/main/packages/latest.piplug":
			mirrorCalls++
			data = archive
		case "https://raw.githubusercontent.com/AIUO-Net/pi-desktop-plugins/main/packages/latest.piplug":
			data = []byte("unavailable")
		default:
			t.Fatalf("unexpected marketplace request %s", req.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data)), Header: make(http.Header)}, nil
	})
	router := registryRouter(m)
	market := readResult[[]marketplacePlugin](t, requestPlugin(router, "GET", "/marketplace", "", nil, true))
	if len(market) != 1 || !slices.Equal(market[0].Versions, []string{"1.10.0", "1.2.0"}) {
		t.Fatalf("unexpected marketplace releases: %#v", market)
	}
	result := readResult[Plugin](t, requestPlugin(router, "POST", "/demo.notes/install", "application/json", strings.NewReader("{}"), true))
	if result.Enabled || result.Source != "marketplace" || result.Version != "1.10.0" || mirrorCalls != 1 {
		t.Fatalf("unexpected verified install: %#v, mirror calls: %d", result, mirrorCalls)
	}
	archive[0] ^= 1
	rejected := requestPlugin(router, "POST", "/demo.notes/install", "application/json", strings.NewReader("{}"), true)
	if rejected.Code != 502 {
		t.Fatalf("corrupt artifact unexpectedly accepted: %d", rejected.Code)
	}
}
