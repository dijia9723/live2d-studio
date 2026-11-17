package desktop

import (
	"github.com/gin-gonic/gin"
	"server/internal/pkg"
	"sync"
)

type Controller interface {
	Pet(bool)
	Pin(bool)
}
type Module struct {
	mu         sync.RWMutex
	controller Controller
}

func (m *Module) Set(c Controller) { m.mu.Lock(); defer m.mu.Unlock(); m.controller = c }
func (m *Module) Available() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.controller != nil
}
func (m *Module) Register(r *gin.RouterGroup) {
	r.GET("/desktop", func(c *gin.Context) {
		m.mu.RLock()
		defer m.mu.RUnlock()
		pkg.OK(c, gin.H{"available": m.controller != nil})
	})
	r.POST("/desktop/:action", func(c *gin.Context) {
		var req struct {
			Enabled bool `json:"enabled"`
		}
		if c.ShouldBindJSON(&req) != nil {
			pkg.Fail(c, 400, "参数无效")
			return
		}
		m.mu.RLock()
		defer m.mu.RUnlock()
		if m.controller == nil {
			pkg.Fail(c, 409, "此功能需要桌面客户端")
			return
		}
		switch c.Param("action") {
		case "pet":
			m.controller.Pet(req.Enabled)
		case "pin":
			m.controller.Pin(req.Enabled)
		default:
			pkg.Fail(c, 404, "未知窗口操作")
			return
		}
		pkg.OK(c, nil)
	})
}
