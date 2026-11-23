// browser_debug_http.go 负责浏览器调试会话的 HTTP 路由与参数校验。
package coding

import (
	"context"
	"errors"
	"net"
	"os"
	"time"

	"server/internal/pkg"

	"github.com/gin-gonic/gin"
)

// registerBrowserDebug 注册浏览器调试路由，并限制只有本机桌面客户端可用。
func (m *Module) registerBrowserDebug(group *gin.RouterGroup) {
	local := group.Group("/browser-debug", func(c *gin.Context) {
		host, _, _ := net.SplitHostPort(c.Request.RemoteAddr)
		if m.BrowserDebug == nil || os.Getenv("STUDIO_CONTAINER") == "1" || !net.ParseIP(host).IsLoopback() {
			pkg.Fail(c, 403, "浏览器调试仅在本机 Studio 中可用")
			return
		}
		c.Next()
	})
	local.POST("", m.startBrowserDebug)
	local.POST("/:browser/navigate", m.navigateBrowserDebug)
	local.GET("/:browser/tree", m.inspectBrowserDebug)
	local.GET("/:browser/screenshot", m.captureBrowserDebug)
	local.DELETE("/:browser", m.stopBrowserDebug)
}

func (m *Module) startBrowserDebug(c *gin.Context) {
	session, err := m.BrowserDebug.start(c.Request.Context())
	if err != nil {
		if errors.Is(err, errBrowserBusy) {
			pkg.Fail(c, 409, err.Error())
		} else {
			pkg.Fail(c, 503, err.Error())
		}
		return
	}
	pkg.OK(c, gin.H{"id": session.id})
}

func (m *Module) activeBrowserDebug(c *gin.Context) *browserDebugSession {
	session, err := m.BrowserDebug.session(c.Param("browser"))
	if err != nil {
		pkg.Fail(c, 404, err.Error())
		return nil
	}
	return session
}

func (m *Module) navigateBrowserDebug(c *gin.Context) {
	var input struct {
		URL string `json:"url"`
	}
	if c.ShouldBindJSON(&input) != nil {
		pkg.Fail(c, 400, "浏览器地址无效")
		return
	}
	target, err := normalizeDebugPage(input.URL)
	if err != nil {
		pkg.Fail(c, 400, err.Error())
		return
	}
	session := m.activeBrowserDebug(c)
	if session == nil {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 12*time.Second)
	defer cancel()
	if err := session.navigate(ctx, target); err != nil {
		pkg.Fail(c, 502, err.Error())
		return
	}
	pkg.OK(c, gin.H{"url": target})
}

func (m *Module) inspectBrowserDebug(c *gin.Context) {
	session := m.activeBrowserDebug(c)
	if session == nil {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()
	nodes, err := session.inspect(ctx)
	if err != nil {
		pkg.Fail(c, 502, err.Error())
		return
	}
	pkg.OK(c, gin.H{"nodes": nodes})
}

func (m *Module) captureBrowserDebug(c *gin.Context) {
	session := m.activeBrowserDebug(c)
	if session == nil {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()
	data, err := session.screenshot(ctx)
	if err != nil {
		pkg.Fail(c, 502, err.Error())
		return
	}
	pkg.OK(c, gin.H{"png": data})
}

func (m *Module) stopBrowserDebug(c *gin.Context) {
	if err := m.BrowserDebug.stop(c.Param("browser")); err != nil {
		pkg.Fail(c, 404, err.Error())
		return
	}
	pkg.OK(c, nil)
}
