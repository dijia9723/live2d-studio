package coding

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestIsolatedBrowserDebug(t *testing.T) {
	if runtime.GOOS == "linux" && os.Geteuid() == 0 {
		t.Skip("Chromium requires a non-root user when its sandbox is active")
	}
	if browserDebugExecutable() == "" {
		t.Skip("Edge or Chromium is not installed")
	}
	page := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, `<!doctype html><title>Studio Debug Test</title><h1>Browser fixture heading</h1>
		<input aria-label="Editable" value="private input value"><button>Fixture action</button>`)
	}))
	defer page.Close()
	service := NewBrowserDebugService()
	defer service.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	session, err := service.start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := normalizeDebugPage("file:///etc/passwd"); err == nil {
		t.Fatal("file URL was accepted")
	}
	if _, err := normalizeDebugPage("https://my-name:my-password@example.test"); err == nil {
		t.Fatal("URL credentials were accepted")
	}
	if err := session.navigate(ctx, page.URL); err != nil {
		t.Fatal(err)
	}
	found := false
	for !found && ctx.Err() == nil {
		nodes, err := session.inspect(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for _, node := range nodes {
			if strings.Contains(node.Label, "private input value") {
				t.Fatalf("input value appeared in safe view: %#v", node)
			}
			if node.Role == "heading" && node.Label == "Browser fixture heading" {
				found = true
			}
		}
		if !found {
			time.Sleep(30 * time.Millisecond)
		}
	}
	if !found {
		t.Fatal("page heading was not present")
	}
	encoded, err := session.screenshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	image, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || !bytes.HasPrefix(image, []byte("\x89PNG\r\n\x1a\n")) {
		t.Fatal("debug screenshot was not a PNG")
	}
	if err := service.stop(session.id); err != nil {
		t.Fatal(err)
	}
	if _, err := service.session(session.id); err == nil {
		t.Fatal("stopped session was available")
	}
	if _, err := os.Stat(session.dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("temporary profile was not removed: %v", err)
	}
}
