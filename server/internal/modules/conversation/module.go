package conversation

import (
	"github.com/gin-gonic/gin"
)

type Module struct{ Service *Service }

func (m *Module) Register(r *gin.RouterGroup) {
	r.GET("/conversations", m.list)
	r.POST("/conversations", m.create)
	r.PUT("/conversations/:id", m.rename)
	r.DELETE("/conversations/:id", m.remove)
	r.GET("/conversations/:id/messages", m.messages)
	r.POST("/conversations/:id/messages", m.send)
}
