package speech

import (
	"github.com/gin-gonic/gin"
	"server/internal/modules/settings"
)

type Module struct{ Settings *settings.Service }

func (m *Module) Register(r *gin.RouterGroup) {
	r.POST("/speech/transcribe", m.transcribe)
	r.POST("/speech/synthesize", m.synthesize)
}
