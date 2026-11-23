// handler.go 负责注册直播模块的 HTTP 路由与请求参数校验。

package livemode

import (
	"errors"
	"strconv"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"server/internal/modules/agent"
	"server/internal/pkg"
)

// Module 把直播服务挂载为一组 HTTP 接口。
type Module struct{ Service *Service }

// Register 注册直播状态、控制、回复与直播记录相关路由。
func (m *Module) Register(r *gin.RouterGroup) {
	live := r.Group("/live")
	live.GET("/state", func(c *gin.Context) { pkg.OK(c, m.Service.Snapshot()) })
	live.GET("/sessions", func(c *gin.Context) {
		// 页码需要设上限，避免超大偏移量拖慢数据库查询。
		page, err := strconv.Atoi(c.DefaultQuery("page", "0"))
		if err != nil || page < 0 || page > 1000000 {
			pkg.Fail(c, 400, "直播记录页码无效")
			return
		}
		result, err := m.Service.archives(c.Request.Context(), page)
		if err != nil {
			pkg.Fail(c, 500, "读取直播记录失败")
			return
		}
		pkg.OK(c, result)
	})
	live.GET("/sessions/:id", func(c *gin.Context) {
		detail, err := m.Service.archiveDetails(c.Request.Context(), c.Param("id"))
		if errors.Is(err, gorm.ErrRecordNotFound) {
			pkg.Fail(c, 404, "这场直播记录不存在")
			return
		}
		if err != nil {
			pkg.Fail(c, 500, "读取本场汇总失败")
			return
		}
		pkg.OK(c, detail)
	})
	live.POST("/sessions/:id/summary", func(c *gin.Context) {
		detail, err := m.Service.summarizeArchive(c.Request.Context(), c.Param("id"))
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			pkg.Fail(c, 404, "这场直播记录不存在")
		case errors.Is(err, errRecording), errors.Is(err, errNoArchiveData):
			pkg.Fail(c, 409, err.Error())
		case err != nil:
			pkg.Fail(c, 502, "生成直播总结失败。"+agent.ErrorMessage(err))
		default:
			pkg.OK(c, detail)
		}
	})
	live.PUT("/config", func(c *gin.Context) {
		var config Config
		if c.ShouldBindJSON(&config) != nil {
			pkg.Fail(c, 400, "直播配置格式无效")
			return
		}
		if err := m.Service.Configure(config); err != nil {
			pkg.Fail(c, 400, err.Error())
			return
		}
		pkg.OK(c, m.Service.Snapshot())
	})
	live.POST("/start", func(c *gin.Context) {
		if err := m.Service.Start(); err != nil {
			pkg.Fail(c, 400, err.Error())
			return
		}
		pkg.OK(c, m.Service.Snapshot())
	})
	live.POST("/stop", func(c *gin.Context) {
		if err := m.Service.Stop(); err != nil {
			pkg.Fail(c, 500, err.Error())
			return
		}
		pkg.OK(c, m.Service.Snapshot())
	})
	live.POST("/reply", func(c *gin.Context) {
		var request struct {
			SessionID string `json:"session_id"`
			EventID   int    `json:"event_id"`
		}
		if c.ShouldBindJSON(&request) != nil || request.EventID < 0 {
			pkg.Fail(c, 400, "回复请求格式无效")
			return
		}
		accepted, err := m.Service.RequestReply(request.SessionID, request.EventID)
		if err != nil {
			pkg.Fail(c, 409, err.Error())
			return
		}
		pkg.OK(c, gin.H{"accepted": accepted, "state": m.Service.Snapshot()})
	})
}
