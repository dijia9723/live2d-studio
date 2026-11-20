package speech

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"server/internal/pkg"
	"server/internal/tts"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

func (m *Module) ttsModels(c *gin.Context) {
	pkg.OK(c, m.TTS.Catalog())
}

func (m *Module) synthesizeLocal(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 24<<10)
	var req struct {
		Text    string  `json:"text"`
		Model   string  `json:"model"`
		Speaker *int    `json:"speaker"`
		Speed   float64 `json:"speed"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Speaker == nil {
		pkg.Fail(c, http.StatusBadRequest, "请输入朗读文本、模型、音色编号和语速")
		return
	}
	m.localAudio(c, req.Text, tts.Options{Model: req.Model, Speaker: *req.Speaker, Speed: req.Speed})
}

func (m *Module) localAudio(c *gin.Context, text string, options tts.Options) {
	text = strings.TrimSpace(text)
	if text == "" || utf8.RuneCountInString(text) > tts.MaxTextLength || strings.ContainsRune(text, 0) {
		pkg.Fail(c, http.StatusBadRequest, "请输入 1–1000 字的有效朗读文本")
		return
	}
	if err := options.Validate(); err != nil {
		pkg.Fail(c, http.StatusBadRequest, err.Error())
		return
	}
	start := time.Now()
	wav, err := m.TTS.Synthesize(c.Request.Context(), text, options)
	switch {
	case errors.Is(err, context.Canceled):
		return
	case errors.Is(err, context.DeadlineExceeded):
		pkg.Fail(c, http.StatusGatewayTimeout, "本地 TTS 合成超时，请缩短文本后重试")
	case errors.Is(err, tts.ErrUnavailable):
		pkg.Fail(c, http.StatusServiceUnavailable, err.Error())
	case errors.Is(err, tts.ErrBusy):
		pkg.Fail(c, http.StatusTooManyRequests, err.Error())
	case err != nil:
		slog.Warn("本地 TTS 合成失败", "model", options.Model, "error", err)
		pkg.Fail(c, http.StatusBadGateway, "本地 TTS 合成失败，请检查模型文件与推理环境")
	default:
		c.Header("Server-Timing", fmt.Sprintf("tts;dur=%.1f", time.Since(start).Seconds()*1000))
		c.Data(http.StatusOK, "audio/wav", wav)
	}
}
