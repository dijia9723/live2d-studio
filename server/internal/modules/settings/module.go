package settings

import (
	"github.com/gin-gonic/gin"
)

type Module struct{ Service *Service }

func (m *Module) Register(r *gin.RouterGroup) {
	r.GET("/settings", m.get)
	r.PUT("/settings", m.save)
	r.POST("/settings/test", m.test)
}
