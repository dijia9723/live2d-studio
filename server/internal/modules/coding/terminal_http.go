// terminal_http.go 负责交互终端的 HTTP 路由、鉴权与 SSE 输出流。
package coding

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"server/internal/pkg"

	"github.com/gin-gonic/gin"
)

// registerTerminal 注册终端路由，并限制只有本机桌面客户端才能访问，避免远程用户拿到 shell。
func (m *Module) registerTerminal(group *gin.RouterGroup) {
	routes := group.Group("/projects/:project/terminals", func(c *gin.Context) {
		host, _, _ := net.SplitHostPort(c.Request.RemoteAddr)
		if m.Terminal == nil || os.Getenv("STUDIO_CONTAINER") == "1" || !net.ParseIP(host).IsLoopback() {
			pkg.Fail(c, 403, "终端仅在本机 Studio 中可用")
			return
		}
		c.Next()
	})
	routes.POST("", m.startTerminal)
	routes.GET("/:terminal/events", m.terminalEvents)
	routes.POST("/:terminal/input", m.terminalInput)
	routes.PUT("/:terminal/size", m.terminalResize)
	routes.DELETE("/:terminal", m.stopTerminal)
}

func (m *Module) startTerminal(c *gin.Context) {
	var size terminalSize
	if c.ShouldBindJSON(&size) != nil || !size.valid() {
		pkg.Fail(c, 400, "终端尺寸无效")
		return
	}
	project, ok := m.project(c, c.Param("project"))
	if !ok {
		return
	}
	resolved, err := filepath.EvalSymlinks(project.Path)
	if err != nil || resolved != project.Path {
		pkg.Fail(c, 409, "项目目录失效，请重新打开项目")
		return
	}
	directory, err := os.Stat(resolved)
	if err != nil || !directory.IsDir() {
		pkg.Fail(c, 409, "项目目录失效，请重新打开项目")
		return
	}
	terminal, err := m.Terminal.start(project.ID, resolved, size)
	if err != nil {
		if errors.Is(err, errTerminalLimit) {
			pkg.Fail(c, 429, err.Error())
		} else {
			pkg.Fail(c, 500, "无法启动终端："+err.Error())
		}
		return
	}
	pkg.OK(c, gin.H{"id": terminal.id})
}

func (m *Module) projectTerminal(c *gin.Context) *terminalSession {
	session := m.Terminal.terminal(c.Param("project"), c.Param("terminal"))
	if session == nil {
		pkg.Fail(c, 404, "终端会话不存在")
	}
	return session
}

func (m *Module) terminalEvents(c *gin.Context) {
	session := m.projectTerminal(c)
	if session == nil {
		return
	}
	cursor, err := strconv.ParseUint(c.DefaultQuery("cursor", "0"), 10, 64)
	if err != nil {
		pkg.Fail(c, 400, "终端输出游标无效")
		return
	}
	detach := session.attach()
	defer detach()
	c.Header("Content-Type", "text/event-stream; charset=utf-8")
	c.Header("X-Accel-Buffering", "no")
	c.Writer.WriteHeaderNow()
	c.Writer.Flush()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	// 每 15 秒发送一次注释帧作为心跳，防止空闲连接被代理或浏览器判定超时断开。
	for {
		select {
		case <-c.Request.Context().Done():
			return
		default:
		}
		event, ready := session.next(cursor)
		if ready != nil {
			select {
			case <-c.Request.Context().Done():
				return
			case <-ready:
			case <-ticker.C:
				if _, err := io.WriteString(c.Writer, ": keepalive\n\n"); err != nil {
					return
				}
				c.Writer.Flush()
			}
			continue
		}
		data, err := json.Marshal(event)
		if err != nil {
			return
		}
		if _, err := fmt.Fprintf(c.Writer, "data: %s\n\n", data); err != nil {
			return
		}
		c.Writer.Flush()
		if event.Type == "exit" {
			return
		}
		cursor = event.Cursor
	}
}

func (m *Module) terminalInput(c *gin.Context) {
	session := m.projectTerminal(c)
	if session == nil {
		return
	}
	var input struct {
		Data []byte `json:"data"`
	}
	if c.ShouldBindJSON(&input) != nil || len(input.Data) == 0 || len(input.Data) > 32<<10 {
		pkg.Fail(c, 400, "终端输入大小无效")
		return
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.stopping || session.exit != nil {
		pkg.Fail(c, 409, "终端已停止")
		return
	}
	select {
	case session.input <- input.Data:
		pkg.OK(c, nil)
	default:
		pkg.Fail(c, 429, "终端输入队列已满")
	}
}

func (m *Module) terminalResize(c *gin.Context) {
	session := m.projectTerminal(c)
	if session == nil {
		return
	}
	var size terminalSize
	if c.ShouldBindJSON(&size) != nil || !size.valid() {
		pkg.Fail(c, 400, "终端尺寸无效")
		return
	}
	if err := session.device.resize(size); err != nil {
		pkg.Fail(c, 409, "当前终端无法调整大小")
		return
	}
	pkg.OK(c, nil)
}

func (m *Module) stopTerminal(c *gin.Context) {
	if session := m.projectTerminal(c); session != nil {
		session.stop()
		pkg.OK(c, nil)
	}
}
