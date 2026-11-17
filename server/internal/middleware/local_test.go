// 本文件覆盖本地访问控制中间件对桌面来源、开发服务器来源与伪造来源的判定。

package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// TestWailsOriginRequiresActiveDesktop 校验 wails.localhost 仅在桌面外壳就绪时
// 放行，并拒绝伪造域名、带路径、带端口或缺少客户端标识的请求。
func TestWailsOriginRequiresActiveDesktop(t *testing.T) {
	gin.SetMode(gin.TestMode)
	active := false
	router := gin.New()
	router.Use(LocalOnly(func() bool { return active }))
	router.POST("/api/v1/test", func(c *gin.Context) { c.Status(200) })
	request := func(origin, method string, client bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://127.0.0.1:43217/api/v1/test", nil)
		r.Header.Set("Origin", origin)
		if client {
			r.Header.Set("X-Studio-Client", "1")
		}
		if method == http.MethodOptions {
			r.Header.Set("Access-Control-Request-Method", "POST")
			r.Header.Set("Access-Control-Request-Headers", "content-type,x-studio-client")
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	if w := request("http://wails.localhost", "POST", true); w.Code != 403 {
		t.Fatal("headless server allowed the desktop origin")
	}
	active = true
	for _, origin := range []string{"http://wails.localhost", "wails://localhost"} {
		if w := request(origin, "POST", true); w.Code != 200 || w.Header().Get("Access-Control-Allow-Origin") != origin {
			t.Fatalf("desktop origin %s was denied: %d", origin, w.Code)
		}
		if w := request(origin, "OPTIONS", false); w.Code != 204 || w.Header().Get("Access-Control-Allow-Headers") != "Content-Type, X-Studio-Client" {
			t.Fatal("desktop preflight request failed")
		}
	}
	for _, origin := range []string{"http://127.0.0.1:9245", "http://localhost:9245", "http://127.0.0.1:5173"} {
		if w := request(origin, "POST", true); w.Code != 200 || w.Header().Get("Access-Control-Allow-Origin") != origin {
			t.Fatalf("vite dev origin %s was denied: %d", origin, w.Code)
		}
	}
	for _, origin := range []string{"null", "https://evil.example", "http://wails.localhost.evil", "http://wails.localhost:1234", "http://wails.localhost/path", "http://127.0.0.1:43217/path", "http://user@127.0.0.1:43217"} {
		if w := request(origin, "POST", true); w.Code != 403 {
			t.Fatalf("spoofed origin accepted: %s", origin)
		}
	}
	if w := request("http://wails.localhost", "POST", false); w.Code != 403 {
		t.Fatal("desktop request no longer requires the client header")
	}
}
