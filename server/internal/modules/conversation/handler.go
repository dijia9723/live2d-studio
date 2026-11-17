package conversation

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"server/internal/model"
	"server/internal/modules/agent"
	"server/internal/pkg"

	"github.com/gin-gonic/gin"
)

func (m *Module) list(c *gin.Context) {
	v, err := m.Service.List()
	if err != nil {
		pkg.Fail(c, 500, "读取会话失败")
		return
	}
	pkg.OK(c, v)
}
func (m *Module) create(c *gin.Context) {
	var req struct {
		CharacterID string `json:"character_id"`
	}
	if c.ShouldBindJSON(&req) != nil {
		pkg.Fail(c, 400, "参数无效")
		return
	}
	v, err := m.Service.Create(req.CharacterID)
	if err != nil {
		pkg.Fail(c, 400, "角色不存在或创建失败")
		return
	}
	pkg.OK(c, v)
}
func (m *Module) rename(c *gin.Context) {
	var req struct {
		Title string `json:"title"`
	}
	if c.ShouldBindJSON(&req) != nil || strings.TrimSpace(req.Title) == "" || len([]rune(req.Title)) > 100 {
		pkg.Fail(c, 400, "标题须为 1–100 个字符")
		return
	}
	result := m.Service.DB.Model(&model.Conversation{}).Where("id = ?", c.Param("id")).Update("title", req.Title)
	if result.Error != nil || result.RowsAffected == 0 {
		pkg.Fail(c, 404, "会话不存在")
		return
	}
	pkg.OK(c, nil)
}
func (m *Module) remove(c *gin.Context) {
	if err := m.Service.Delete(c.Param("id")); err != nil {
		if errors.Is(err, ErrBusy) {
			pkg.Fail(c, 409, err.Error())
		} else {
			pkg.Fail(c, 404, "会话不存在或删除失败")
		}
		return
	}
	pkg.OK(c, nil)
}
func (m *Module) messages(c *gin.Context) {
	v, err := m.Service.Messages(c.Param("id"))
	if err != nil {
		pkg.Fail(c, 404, "会话不存在")
		return
	}
	pkg.OK(c, v)
}
func (m *Module) send(c *gin.Context) {
	var req struct {
		Text  string `json:"text"`
		Image string `json:"image"`
	}
	if c.ShouldBindJSON(&req) != nil || strings.TrimSpace(req.Text) == "" || len(req.Text) > 32000 {
		pkg.Fail(c, 400, "消息不能为空，且最多 32000 字节")
		return
	}
	if req.Image != "" {
		parts := strings.SplitN(req.Image, ",", 2)
		if len(parts) != 2 || (parts[0] != "data:image/png;base64" && parts[0] != "data:image/jpeg;base64" && parts[0] != "data:image/webp;base64") {
			pkg.Fail(c, 400, "不支持的图片格式")
			return
		}
		data, err := base64.StdEncoding.DecodeString(parts[1])
		if err != nil || len(data) > 4<<20 {
			pkg.Fail(c, 400, "图片无效或大于 4MB")
			return
		}
	}
	if _, err := m.Service.Get(c.Param("id")); err != nil {
		pkg.Fail(c, 404, "会话不存在")
		return
	}
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("X-Accel-Buffering", "no")
	ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Minute)
	defer cancel()
	var writeMu sync.Mutex
	emit := func(e Event) {
		writeMu.Lock()
		defer writeMu.Unlock()
		b, _ := json.Marshal(e)
		_, _ = fmt.Fprintf(c.Writer, "data: %s\n\n", b)
		c.Writer.Flush()
	}
	err := m.Service.Stream(ctx, c.Param("id"), req.Text, req.Image, emit)
	if err != nil && ctx.Err() == nil {
		message := agent.ErrorMessage(err)
		if errors.Is(err, ErrBusy) {
			message = err.Error()
		}
		emit(Event{Type: "error", Text: message})
	}
}
