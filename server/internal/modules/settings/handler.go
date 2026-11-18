// 本文件实现设置读取、保存与模型连通性测试的 HTTP 处理。

package settings

import (
	"context"
	"os"
	"server/internal/config"
	"server/internal/model"
	"server/internal/modules/agent"
	"server/internal/pkg"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// safe 生成可下发的配置视图：清空两项 API Key，只通过 has_*_key 告知是否已配置，
// 并列出被环境变量覆盖、界面无法修改的字段名。
func safe(v Values) gin.H {
	hasLLM, hasSpeech := v.LLM.APIKey != "", v.Speech.APIKey != ""
	v.LLM.APIKey = ""
	v.Speech.APIKey = ""
	locked := []string{}
	for _, key := range []string{"STUDIO_LLM_PROVIDER", "STUDIO_LLM_API_KEY", "STUDIO_LLM_BASE_URL", "STUDIO_LLM_MODEL", "STUDIO_SPEECH_API_KEY"} {
		if os.Getenv(key) != "" {
			locked = append(locked, key)
		}
	}
	return gin.H{"llm": v.LLM, "speech": v.Speech, "has_llm_key": hasLLM, "has_speech_key": hasSpeech, "environment_overrides": locked}
}

// get 返回生效配置的安全视图，密钥永远不会下发到前端。
func (m *Module) get(c *gin.Context) {
	v, err := m.Service.Get()
	if err != nil {
		pkg.Fail(c, 500, "读取设置失败")
		return
	}
	_, saved, err := m.Service.Profile(v.LLM.Provider)
	if err != nil {
		pkg.Fail(c, 500, "读取模型服务配置失败")
		return
	}
	result := safe(v)
	result["llm_profile_saved"] = saved
	pkg.OK(c, result)
}

// profile 只读取指定服务，不切换聊天当前使用的服务，且绝不返回密钥内容。
func (m *Module) profile(c *gin.Context) {
	if _, ok := config.LLMProviderDefaults(c.Param("provider")); !ok {
		pkg.Fail(c, 400, "不支持的模型服务类型")
		return
	}
	v, saved, err := m.Service.Profile(c.Param("provider"))
	if err != nil {
		pkg.Fail(c, 500, "读取模型服务配置失败，请稍后重试")
		return
	}
	hasKey := v.APIKey != ""
	v.APIKey = ""
	pkg.OK(c, gin.H{"llm": v, "has_llm_key": hasKey, "saved": saved})
}

// Request 是保存设置的请求体。
// API Key 留空表示保留原值（界面不回传密钥），Clear*Key 为真时显式清除已保存的密钥。
type Request struct {
	Values
	ClearLLMKey    bool `json:"clear_llm_key"`
	ClearSpeechKey bool `json:"clear_speech_key"`
}

// save 校验并保存配置，成功后再返回最新的安全视图。
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

// test 用当前生效配置发起一次真实流式对话，只有确实收到文本才算连通，
// 避免仅能建立连接、却无法生成回复的配置被误判为成功。
func (m *Module) test(c *gin.Context) {
	v, err := m.Service.Get()
	if err != nil {
		pkg.Fail(c, 500, "读取设置失败")
		return
	}
	timeout := 60 * time.Second
	if v.LLM.Provider == "ollama" {
		timeout = 120 * time.Second // 首次加载本地模型可能需要更长时间。
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), timeout)
	defer cancel()
	// 使用真实的流式路径与参数，确保连通性测试不会对无法产生回复的配置误报成功。
	content := ""
	err = m.Agent.Stream(ctx, v.LLM, model.Character{SystemPrompt: "This is a connection test. Reply briefly."}, []model.Message{{Role: "user", Content: "Reply with OK."}}, func(e agent.Event) {
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
