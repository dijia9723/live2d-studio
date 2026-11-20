package livemode

import (
	"github.com/gin-gonic/gin"
	"server/internal/pkg"
)

type Module struct{ Service *Service }

func (m *Module) Register(r *gin.RouterGroup) {
	live := r.Group("/live")
	live.GET("/state", func(c *gin.Context) { pkg.OK(c, m.Service.Snapshot()) })
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
		var request struct {
			Demo bool `json:"demo"`
		}
		if c.ShouldBindJSON(&request) != nil {
			pkg.Fail(c, 400, "直播请求格式无效")
			return
		}
		if err := m.Service.Start(request.Demo); err != nil {
			pkg.Fail(c, 400, err.Error())
			return
		}
		pkg.OK(c, m.Service.Snapshot())
	})
	live.POST("/stop", func(c *gin.Context) {
		m.Service.Stop()
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
	live.POST("/demo-event", func(c *gin.Context) {
		var request struct {
			Kind Kind `json:"kind"`
		}
		if c.ShouldBindJSON(&request) != nil {
			pkg.Fail(c, 400, "演练事件格式无效")
			return
		}
		if err := m.Service.AddDemoEvent(request.Kind); err != nil {
			pkg.Fail(c, 400, err.Error())
			return
		}
		pkg.OK(c, m.Service.Snapshot())
	})
}
