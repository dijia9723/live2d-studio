// 本文件实现语音识别与语音合成的转发处理，包括大小限制与上游错误映射。

package speech

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"server/internal/pkg"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// proxy 以当前语音配置向外部服务发起 POST，附加 Bearer 密钥并设置 90 秒超时；
// 请求沿用客户端 ctx，前端取消时上游请求也会被取消。
func (m *Module) proxy(c *gin.Context, path, contentType string, body io.Reader) (*http.Response, error) {
	cfg, err := m.Settings.Get()
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(c.Request.Context(), "POST", strings.TrimRight(cfg.Speech.BaseURL, "/")+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", contentType)
	if cfg.Speech.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.Speech.APIKey)
	}
	return (&http.Client{Timeout: 90 * time.Second}).Do(req)
}

// transcribe 接收不超过 25MB 的音频，重新封装为 multipart 后转发给 /audio/transcriptions；
// 只解析上游响应前 1MB，防止异常服务返回超大响应占用内存。
func (m *Module) transcribe(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 25<<20)
	f, err := c.FormFile("file")
	if err != nil {
		pkg.Fail(c, 400, "请选择小于 25MB 的音频文件")
		return
	}
	if c.Request.MultipartForm != nil {
		defer c.Request.MultipartForm.RemoveAll()
	}
	cfg, err := m.Settings.Get()
	if err != nil {
		pkg.Fail(c, 500, "读取设置失败")
		return
	}
	in, err := f.Open()
	if err != nil {
		pkg.Fail(c, 400, "读取音频失败")
		return
	}
	defer in.Close()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", f.Filename)
	if err != nil {
		pkg.Fail(c, 500, "编码音频失败")
		return
	}
	if _, err = io.Copy(part, in); err != nil {
		pkg.Fail(c, 400, "读取音频失败")
		return
	}
	writer.WriteField("model", cfg.Speech.ASRModel)
	writer.Close()
	resp, err := m.proxy(c, "/audio/transcriptions", writer.FormDataContentType(), &body)
	if err != nil {
		pkg.Fail(c, 502, "语音识别服务连接失败")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		pkg.Fail(c, 502, "语音识别失败，请检查语音服务设置")
		return
	}
	var out struct {
		Text string `json:"text"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out) != nil {
		pkg.Fail(c, 502, "语音服务返回了无效数据")
		return
	}
	pkg.OK(c, out)
}

// synthesize 依据角色的朗读配置合成音频。
func (m *Module) synthesize(c *gin.Context) {
	var req struct {
		Text        string `json:"text"`
		CharacterID string `json:"character_id"`
	}
	if c.ShouldBindJSON(&req) != nil || strings.TrimSpace(req.Text) == "" || len(req.Text) > 20000 {
		pkg.Fail(c, 400, "请输入有效的朗读文本")
		return
	}
	cfg, err := m.Settings.Get()
	if err != nil {
		pkg.Fail(c, 500, "读取设置失败")
		return
	}
	voice := cfg.Speech.Voice
	if req.CharacterID != "" {
		character, err := m.Characters.Get(req.CharacterID)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			pkg.Fail(c, 404, "角色不存在")
			return
		}
		if err != nil {
			pkg.Fail(c, 500, "读取角色语音配置失败")
			return
		}
		if cfg.Speech.Mode == "off" {
			pkg.Fail(c, 400, "请先在设置中开启语音")
			return
		}
		mode := cfg.Speech.Mode
		if character.Speech == nil || character.Speech.Mode == "inherit" {
			if cfg.Speech.LocalTTS != nil {
				m.localAudio(c, req.Text, *cfg.Speech.LocalTTS)
				return
			}
		} else {
			mode = character.Speech.Mode
			if mode == "local" && character.Speech.LocalTTS != nil {
				m.localAudio(c, req.Text, *character.Speech.LocalTTS)
				return
			}
			if mode == "api" && character.Speech.Voice != "" {
				voice = character.Speech.Voice
			}
		}
		if mode != "api" {
			pkg.Fail(c, 400, "角色使用系统语音，请在客户端朗读")
			return
		}
	} else if cfg.Speech.Mode != "off" && cfg.Speech.LocalTTS != nil {
		// Older clients can still request the previously saved default without a character ID.
		m.localAudio(c, req.Text, *cfg.Speech.LocalTTS)
		return
	}
	b, _ := json.Marshal(map[string]any{"model": cfg.Speech.TTSModel, "voice": voice, "input": req.Text, "response_format": "mp3"})
	resp, err := m.proxy(c, "/audio/speech", "application/json", bytes.NewReader(b))
	if err != nil {
		pkg.Fail(c, 502, "语音合成服务连接失败")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		pkg.Fail(c, 502, "语音合成失败，请检查语音服务设置")
		return
	}
	c.Header("Content-Type", "audio/mpeg")
	_, _ = io.Copy(c.Writer, io.LimitReader(resp.Body, 30<<20))
}
