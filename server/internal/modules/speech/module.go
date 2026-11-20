// Package speech 提供语音接口，支持 OpenAI 兼容服务与本地 TTS，
// 路由前缀为 /api/v1/speech；密钥只保存在服务端，不会下发给前端。
package speech

import (
	"server/internal/modules/character"
	"server/internal/modules/settings"
	"server/internal/tts"

	"github.com/gin-gonic/gin"
)

// Module 持有设置服务，用于读取生效的语音配置。
type Module struct {
	Characters *character.Service
	Settings   *settings.Service
	TTS        *tts.Runtime
}

// Register 挂载语音识别与语音合成接口。
func (m *Module) Register(r *gin.RouterGroup) {
	r.POST("/speech/transcribe", m.transcribe)
	r.POST("/speech/synthesize", m.synthesize)
	r.GET("/speech/tts/models", m.ttsModels)
	r.POST("/speech/tts/synthesize", m.synthesizeLocal)
}
