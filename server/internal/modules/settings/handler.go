package settings

import (
	"context"
	"os"
	"server/internal/model"
	"server/internal/modules/agent"
	"server/internal/pkg"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

func safe(v Values) gin.H {
	hasLLM, hasSpeech := v.LLM.APIKey != "", v.Speech.APIKey != ""
	v.LLM.APIKey = ""
	v.Speech.APIKey = ""
	locked := []string{}
	for _, key := range []string{"STUDIO_LLM_API_KEY", "STUDIO_LLM_BASE_URL", "STUDIO_LLM_MODEL", "STUDIO_SPEECH_API_KEY"} {
		if os.Getenv(key) != "" {
			locked = append(locked, key)
		}
	}
	return gin.H{"llm": v.LLM, "speech": v.Speech, "has_llm_key": hasLLM, "has_speech_key": hasSpeech, "environment_overrides": locked}
}
func (m *Module) get(c *gin.Context) {
	v, err := m.Service.Get()
	if err != nil {
		pkg.Fail(c, 500, "读取设置失败")
		return
	}
	pkg.OK(c, safe(v))
}

type Request struct {
	Values
	ClearLLMKey    bool `json:"clear_llm_key"`
	ClearSpeechKey bool `json:"clear_speech_key"`
}

func (m *Module) save(c *gin.Context) {
	var req Request
	if c.ShouldBindJSON(&req) != nil {
		pkg.Fail(c, 400, "配置格式无效")
		return
	}
	if err := m.Service.Save(req.Values, req.ClearLLMKey, req.ClearSpeechKey); err != nil {
		pkg.Fail(c, 400, err.Error())
		return
	}
	m.get(c)
}
func (m *Module) test(c *gin.Context) {
	v, err := m.Service.Get()
	if err != nil {
		pkg.Fail(c, 500, "读取设置失败")
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()
	// Use the real streaming path and parameters so a connection test cannot
	// report success for settings that cannot actually produce a chat reply.
	content := ""
	err = (&agent.Service{}).Stream(ctx, v.LLM, model.Character{SystemPrompt: "This is a connection test. Reply briefly."}, []model.Message{{Role: "user", Content: "Reply with OK."}}, func(e agent.Event) {
		if e.Type == "delta" {
			content += e.Text
		}
	})
	if err == nil && strings.TrimSpace(content) == "" {
		err = agent.ErrEmptyResponse
	}
	if err != nil {
		pkg.Fail(c, 502, agent.ErrorMessage(err))
		return
	}
	pkg.OK(c, gin.H{"connected": true})
}
