// Package desktop 暴露桌面壳层的模式切换与窗口置顶能力，
// 路由前缀为 /api/v1/desktop。
package desktop

import (
	"errors"
	"server/internal/pkg"
	"sync"

	"github.com/gin-gonic/gin"
)

// Controller 由桌面壳层实现；在 headless 构建中不会被注入。
type Controller interface {
	Pet(bool, *PetHandoff)
	Coding(bool)
	Pin(bool)
}

type PetHandoff struct {
	CharacterID    string `json:"character_id"`
	ConversationID string `json:"conversation_id"`
	ChooseWindow   bool   `json:"choose_window"`
	WatchID        string `json:"-"`
}

// Module 用读写锁保护可选的 Controller，使 HTTP 请求与启动期注入不产生数据竞争。
type Module struct {
	mu         sync.RWMutex
	controller Controller
}

// Set 注入桌面控制器；传入 nil 表示当前环境不具备桌面窗口能力。
func (m *Module) Set(c Controller) { m.mu.Lock(); defer m.mu.Unlock(); m.controller = c }

// Available 报告当前是否运行在可控窗口的桌面环境中。
func (m *Module) Available() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.controller != nil
}

func (m *Module) PickDirectory() (string, error) {
	m.mu.RLock()
	picker, ok := m.controller.(interface{ PickDirectory() (string, error) })
	m.mu.RUnlock()
	if !ok {
		return "", errors.New("此功能需要桌面客户端")
	}
	return picker.PickDirectory()
}

// Register 挂载桌面能力查询与窗口操作接口。
// 没有桌面控制器时返回 409 而不是静默成功，前端可据此隐藏相关开关。
func (m *Module) Register(r *gin.RouterGroup) {
	r.GET("/desktop", func(c *gin.Context) {
		m.mu.RLock()
		defer m.mu.RUnlock()
		pkg.OK(c, gin.H{"available": m.controller != nil})
	})
	r.POST("/desktop/:action", func(c *gin.Context) {
		var req struct {
			Enabled bool        `json:"enabled"`
			Handoff *PetHandoff `json:"handoff"`
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
			m.controller.Pet(req.Enabled, req.Handoff)
		case "coding":
			m.controller.Coding(req.Enabled)
		case "pin":
			m.controller.Pin(req.Enabled)
		default:
			pkg.Fail(c, 404, "未知窗口操作")
			return
		}
		pkg.OK(c, nil)
	})
}
