package sceneassets

import "github.com/gin-gonic/gin"

type Module struct{ Service *Service }

func (m *Module) Register(r *gin.RouterGroup) {
	r.GET("/scene-assets", m.list)
	r.POST("/scene-assets", m.upload)
	r.DELETE("/scene-assets/:id", m.remove)
}

func (m *Module) RegisterMedia(r *gin.Engine) {
	r.GET("/scene-media/*path", m.media)
	r.HEAD("/scene-media/*path", m.media)
}
