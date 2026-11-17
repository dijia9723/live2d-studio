package middleware

import (
	"net"
	"net/http"
	"net/url"
	"os"
	"server/internal/pkg"
	"strings"

	"github.com/gin-gonic/gin"
)

// 前端开发服务器（Vite）端口可变，wails3 dev 默认使用 9245，因此本机回环来源
// 不限制端口；wails.localhost 仍只允许精确匹配，避免放开桌面来源的端口限制。
func loopbackOrigin(hostport string) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isDesktopOrigin(origin string, desktopAvailable func() bool) bool {
	if desktopAvailable == nil || !desktopAvailable() {
		return false
	}
	if origin == "http://wails.localhost" || origin == "wails://localhost" {
		return true
	}
	// Wails 3 dev mode adds the Vite port to its wails.localhost origin.
	// Allow that exact configured port while keeping other ports and hosts closed.
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" || u.Hostname() != "wails.localhost" || u.Port() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	devServer, err := url.Parse(os.Getenv("FRONTEND_DEVSERVER_URL"))
	return err == nil && (devServer.Scheme == "http" || devServer.Scheme == "https") && devServer.Port() != "" && u.Port() == devServer.Port()
}

// The local API must not be writable by an unrelated webpage or a rebound hostname.
func LocalOnly(desktopAvailable func() bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		host := c.Request.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		if host != "localhost" && host != "wails.localhost" && (net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback()) {
			pkg.Fail(c, 403, "不允许的主机")
			return
		}
		origin := c.GetHeader("Origin")
		if origin != "" {
			u, err := url.Parse(origin)
			allowed := err == nil && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == "" && (u.Host == c.Request.Host || loopbackOrigin(u.Host)) && (u.Scheme == "http" || u.Scheme == "https")
			if isDesktopOrigin(origin, desktopAvailable) {
				allowed = true
			}
			if !allowed {
				pkg.Fail(c, 403, "不允许的来源")
				return
			}
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Vary", "Origin")
			c.Header("Access-Control-Allow-Headers", "Content-Type, X-Studio-Client")
			c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(204)
			return
		}
		if strings.HasPrefix(c.Request.URL.Path, "/api/") && c.Request.Method != "GET" && c.Request.Method != "HEAD" && c.GetHeader("X-Studio-Client") != "1" {
			pkg.Fail(c, 403, "缺少客户端标识")
			return
		}
		c.Header("X-Content-Type-Options", "nosniff")
		c.Next()
	}
}
