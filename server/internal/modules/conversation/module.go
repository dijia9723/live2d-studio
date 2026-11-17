// Package conversation 管理会话、消息历史与 SSE 流式回复，
// 路由前缀为 /api/v1/conversations。
package conversation

import (
	"github.com/gin-gonic/gin"
)

// Module 注册会话相关路由。
type Module struct{ Service *Service }

// Register 挂载会话列表、创建、重命名、删除、消息读取与发送接口。
func (m *Module) Register(r *gin.RouterGroup) {
	r.GET("/conversations", m.list)
	r.POST("/conversations", m.create)
	r.PUT("/conversations/:id", m.rename)
	r.DELETE("/conversations/:id", m.remove)
	r.GET("/conversations/:id/messages", m.messages)
	r.POST("/conversations/:id/messages", m.send)
}
