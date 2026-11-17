// 本文件覆盖桌面资源代理：API 地址注入、目标地址校验与请求头规范化。

package webui

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"
)

// TestDesktopHTMLPointsAPIAtRealListener 校验注入的 API 地址指向真实监听端口，
// SSE 首帧不被缓冲，且非 HTML 资源保持原样。
func TestDesktopHTMLPointsAPIAtRealListener(t *testing.T) {
	// 会整体缓冲的资源层无法传递实时事件，注入的 API 地址必须让浏览器
	// 绕过该层直接访问本监听地址。
	finish := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("ETag", "old-index")
			fmt.Fprint(w, `<!doctype html><html><head><script type="module" src="/app.js"></script></head><body></body></html>`)
		case "/api/v1/events":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: first\n\n")
			w.(http.Flusher).Flush()
			select {
			case <-finish:
			case <-r.Context().Done():
			}
		default:
			w.Header().Set("Content-Type", "application/javascript")
			fmt.Fprint(w, "export const asset = 1")
		}
	}))
	t.Cleanup(upstream.Close)
	t.Cleanup(func() { close(finish) })
	handler, err := DesktopHandler(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	page := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "http://wails.localhost/", nil)
	req.Header.Set("Origin", "http://wails.localhost")
	handler.ServeHTTP(page, req)
	if page.Code != 200 {
		t.Fatalf("desktop response: %d %s", page.Code, page.Body.String())
	}
	body := page.Body.String()
	if !strings.HasPrefix(body, "<!doctype html><html><head><script>window.__STUDIO_API_BASE_URL__=") || strings.Count(body, "__STUDIO_API_BASE_URL__") != 1 {
		t.Fatalf("configuration must precede the application module: %s", body)
	}
	if page.Header().Get("Cache-Control") != "no-store" || page.Header().Get("ETag") != "" || page.Header().Get("Content-Length") != fmt.Sprint(len(body)) {
		t.Fatal("rewritten document has stale cache or content length headers")
	}
	match := regexp.MustCompile(`__STUDIO_API_BASE_URL__=("[^"]+");`).FindStringSubmatch(body)
	if len(match) != 2 {
		t.Fatal("missing API configuration")
	}
	var apiURL string
	if err = json.Unmarshal([]byte(match[1]), &apiURL); err != nil || apiURL != upstream.URL+"/api/v1" {
		t.Fatalf("API origin does not use the active listener: %s", apiURL)
	}
	client := &http.Client{Timeout: time.Second}
	response, err := client.Get(apiURL + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	line, err := bufio.NewReader(response.Body).ReadString('\n')
	if err != nil || line != "data: first\n" {
		t.Fatalf("first event was buffered until completion: %q, %v", line, err)
	}
	asset := httptest.NewRecorder()
	handler.ServeHTTP(asset, httptest.NewRequest(http.MethodGet, "http://wails.localhost/app.js", nil))
	if asset.Code != 200 || asset.Body.String() != "export const asset = 1" {
		t.Fatal("non-HTML asset was modified")
	}
}

// TestDesktopHandlerRejectsRemoteTargets 校验代理拒绝非回环、带认证信息或带
// 查询参数的远端目标。
func TestDesktopHandlerRejectsRemoteTargets(t *testing.T) {
	for _, address := range []string{"https://example.com", "http://example.com", "http://localhost.evil", "http://user:pass@127.0.0.1", "http://127.0.0.1?bad=1"} {
		if _, err := DesktopHandler(address); err == nil {
			t.Fatalf("unexpected remote target accepted: %s", address)
		}
	}
}

// TestDesktopHandlerRewritesHostAndOrigin 校验转发时 Host、Origin 与
// Accept-Encoding 被规范化。
func TestDesktopHandlerRewritesHostAndOrigin(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host == "wails.localhost" || r.Header.Get("Origin") != "http://"+r.Host || r.Header.Get("Accept-Encoding") != "identity" {
			t.Error("desktop proxy did not normalize the upstream request")
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, "{}")
	}))
	defer upstream.Close()
	handler, err := DesktopHandler(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "http://wails.localhost/api/v1/health", nil)
	req.Header.Set("Origin", "http://wails.localhost")
	req.Header.Set("Accept-Encoding", "br")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != 200 {
		t.Fatal("desktop proxy failed")
	}
}
