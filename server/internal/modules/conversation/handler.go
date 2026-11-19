// 本文件实现会话的 HTTP 处理器，包含把模型流转换为 SSE 的发送逻辑。

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

// list 按更新时间倒序返回全部会话。
func (m *Module) list(c *gin.Context) {
	v, err := m.Service.List()
	if err != nil {
		pkg.Fail(c, 500, "读取会话失败")
		return
	}
	pkg.OK(c, v)
}

// create 为指定角色创建会话，角色不存在时返回 400。
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

// rename 更新会话标题，按字符数（而非字节数）限制为 1–100。
func (m *Module) rename(c *gin.Context) {
	var req struct {
		Title string `json:"title"`
	}
	if c.ShouldBindJSON(&req) != nil {
		pkg.Fail(c, 400, "标题须为 1–100 个字符")
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" || len([]rune(title)) > 100 {
		pkg.Fail(c, 400, "标题须为 1–100 个字符")
		return
	}
	result := m.Service.DB.WithContext(c.Request.Context()).Model(&model.Conversation{}).
		Where("id = ?", c.Param("id")).UpdateColumn("title", title)
	if result.Error != nil {
		pkg.Fail(c, 500, "保存标题失败")
		return
	}
	if result.RowsAffected == 0 {
		pkg.Fail(c, 404, "会话不存在")
		return
	}
	pkg.OK(c, nil)
}

// remove 删除会话；会话正在生成时返回 409，避免删除与流式写入竞争。
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

// messages 返回指定会话的全部消息，按创建顺序排列。
func (m *Module) messages(c *gin.Context) {
	v, err := m.Service.Messages(c.Param("id"))
	if err != nil {
		pkg.Fail(c, 404, "会话不存在")
		return
	}
	pkg.OK(c, v)
}

// send 校验文本与内联图片后建立 SSE 连接并转发流式事件。
// 事件类型依次可能为 user（已落库的用户消息）、delta（文本增量）、expression（表情切换）、
// stage_action（模型动作/原生表情请求）、character（已保存角色资料）、tool（工具运行状态）、done（已保存的完整回复）与 error（脱敏后的错误提示）。
// 请求超时为 3 分钟；客户端断开导致 ctx 取消时，服务层会把回复标记为 interrupted。
func (m *Module) send(c *gin.Context) {
	var req struct {
		Text               string             `json:"text"`
		Image              string             `json:"image"`
		ScreenSnipRequests bool               `json:"screen_snip_requests"`
		Screen             *screenObservation `json:"screen_context"`
	}
	if c.ShouldBindJSON(&req) != nil || strings.TrimSpace(req.Text) == "" || len(req.Text) > maxMessageTextBytes {
		pkg.Fail(c, 400, "消息不能为空，且最多 32000 字节")
		return
	}
	imageToCheck, imageLimit := req.Image, maxMessageImageBytes
	if req.Screen != nil {
		if len(req.Screen.Text) > 6400 || (req.Image != "" && req.Screen.Image != "") {
			pkg.Fail(c, 400, "观看上下文过长或重复附图")
			return
		}
		if req.Screen.Image != "" {
			imageToCheck, imageLimit = req.Screen.Image, 768<<10
		}
	}
	if imageToCheck != "" {
		parts := strings.SplitN(imageToCheck, ",", 2)
		if len(parts) != 2 || (parts[0] != "data:image/png;base64" && parts[0] != "data:image/jpeg;base64" && parts[0] != "data:image/webp;base64") {
			pkg.Fail(c, 400, "不支持的图片格式")
			return
		}
		data, err := base64.StdEncoding.DecodeString(parts[1])
		if err != nil || len(data) > imageLimit {
			message := "图片无效或大于 4MB"
			if imageLimit != maxMessageImageBytes {
				message = "观看裁图无效或大于 768KB"
			}
			pkg.Fail(c, 400, message)
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
	if req.ScreenSnipRequests {
		ctx = agent.WithScreenSnipRequests(ctx)
	}
	if req.Screen != nil {
		ctx = context.WithValue(ctx, screenObservationKey{}, *req.Screen)
	}
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
