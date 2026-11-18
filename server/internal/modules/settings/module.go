// Package settings 读写模型与语音配置，并通过一次真实流式请求验证连通性，
// 路由前缀为 /api/v1/settings。
package settings

import (
	"github.com/gin-gonic/gin"
	"server/internal/modules/agent"
)

// Module 注册设置读写与连接测试接口。
type Module struct {
	Service *Service
	Agent   agent.Streamer
}

// Register 挂载设置读取、保存与连通性测试接口。
func (m *Module) Register(r *gin.RouterGroup) {
	r.GET("/settings", m.get)
	r.GET("/settings/llm/:provider", m.profile)
	r.PUT("/settings", m.save)
	r.POST("/settings/test", m.test)
	r.POST("/settings/ollama/models", m.ollamaModels)
}
