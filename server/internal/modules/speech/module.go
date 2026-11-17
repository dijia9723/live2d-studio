// Package speech 代理 OpenAI 兼容的语音识别与语音合成接口，
// 路由前缀为 /api/v1/speech；密钥只保存在服务端，不会下发给前端。
package speech

import (
	"github.com/gin-gonic/gin"
	"server/internal/modules/settings"
)

// Module 持有设置服务，用于读取生效的语音配置。
type Module struct{ Settings *settings.Service }

// Register 挂载语音识别与语音合成接口。
func (m *Module) Register(r *gin.RouterGroup) {
	r.POST("/speech/transcribe", m.transcribe)
	r.POST("/speech/synthesize", m.synthesize)
}
