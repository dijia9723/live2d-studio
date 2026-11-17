// Package middleware 提供本地服务的访问控制：校验 Host 防止 DNS 重绑定，
// 校验 Origin 阻止其他网页跨站调用，并要求写操作携带客户端标识。
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

// loopbackOrigin 判断来源主机是否为 localhost 或任意回环 IP。
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

// isDesktopOrigin 判断来源是否属于 Wails 桌面外壳本身。只有桌面构建登记了
// 可用实现时才允许，headless 构建始终返回 false。
func isDesktopOrigin(origin string, desktopAvailable func() bool) bool {
	if desktopAvailable == nil || !desktopAvailable() {
		return false
	}
	if origin == "http://wails.localhost" || origin == "wails://localhost" {
		return true
	}
	// Wails 3 开发模式会把 Vite 端口附加到 wails.localhost 来源上，
	// 只放行与 FRONTEND_DEVSERVER_URL 完全一致的端口，其他主机与端口仍拒绝。
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "http" || u.Hostname() != "wails.localhost" || u.Port() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	devServer, err := url.Parse(os.Getenv("FRONTEND_DEVSERVER_URL"))
	return err == nil && (devServer.Scheme == "http" || devServer.Scheme == "https") && devServer.Port() != "" && u.Port() == devServer.Port()
}

// LocalOnly 返回访问控制中间件：本地 API 不允许无关网页写入，也不接受被
// 重绑定到本机的恶意域名。
//
// 校验顺序：Host 必须是 localhost/wails.localhost/回环 IP → Origin 必须在
// 白名单内（同源、回环来源或当前桌面外壳）→ OPTIONS 预检直接返回 204 →
// /api/ 下的非只读请求必须带 X-Studio-Client: 1 客户端标识。
func LocalOnly(desktopAvailable func() bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Host 校验拦截 DNS 重绑定：攻击域名解析到 127.0.0.1 时 Host 仍非法。
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
			// 只回显被允许的 Origin，并声明允许的自定义请求头供预检使用。
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Vary", "Origin")
			c.Header("Access-Control-Allow-Headers", "Content-Type, X-Studio-Client")
			c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(204)
			return
		}
		// 写操作要求前端显式声明身份，阻止普通网页用表单或简单请求直接改数据。
		if strings.HasPrefix(c.Request.URL.Path, "/api/") && c.Request.Method != "GET" && c.Request.Method != "HEAD" && c.GetHeader("X-Studio-Client") != "1" {
			pkg.Fail(c, 403, "缺少客户端标识")
			return
		}
		c.Header("X-Content-Type-Options", "nosniff")
		c.Next()
	}
}
