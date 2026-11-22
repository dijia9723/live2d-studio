package coding

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	"server/internal/config"
	"server/internal/model"
	"server/internal/pkg"

	"github.com/gin-gonic/gin"
)

type modelSelection struct {
	Provider string `json:"model_provider"`
	Name     string `json:"model_name"`
}

type modelOption struct {
	Provider  string `json:"provider"`
	Model     string `json:"model"`
	Available bool   `json:"available"`
}

type resolvedModelSelection struct {
	modelSelection
	Effective modelOption `json:"effective"`
}

var codingModelProviders = []string{"openai", "deepseek", "ollama", "lmstudio"}

func sessionSelection(session model.CodingSession) modelSelection {
	return modelSelection{Provider: session.ModelProvider, Name: session.ModelName}
}

func normalizeModelSelection(selection modelSelection) (modelSelection, error) {
	selection.Provider, selection.Name = strings.TrimSpace(selection.Provider), strings.TrimSpace(selection.Name)
	if selection.Provider == "" && selection.Name == "" {
		return selection, nil
	}
	if _, ok := config.LLMProviderDefaults(selection.Provider); !ok {
		return modelSelection{}, errors.New("请选择支持的模型服务")
	}
	if selection.Name == "" || utf8.RuneCountInString(selection.Name) > 200 || strings.ContainsFunc(selection.Name, unicode.IsControl) {
		return modelSelection{}, errors.New("模型名称需为 1–200 个普通字符")
	}
	return selection, nil
}

func codingProviderAvailable(llm config.LLM) bool {
	return llm.Provider == "ollama" || llm.Provider == "lmstudio" || strings.TrimSpace(llm.APIKey) != ""
}

func codingLLMReady(llm config.LLM) error {
	if !codingProviderAvailable(llm) {
		return errors.New("请先在语言模型设置中配置此服务")
	}
	if strings.TrimSpace(llm.Model) == "" {
		return errors.New("请先选择此会话的语言模型")
	}
	return nil
}

func (m *Module) resolveSessionLLM(session model.CodingSession) (config.LLM, error) {
	return m.resolveSelectedLLM(sessionSelection(session))
}

func (m *Module) resolveSelectedLLM(selection modelSelection) (config.LLM, error) {
	global, err := m.Settings.Get()
	if err != nil {
		return config.LLM{}, errors.New("读取语言模型设置失败")
	}
	if selection.Provider == "" {
		return global.LLM, nil
	}
	profile, err := m.effectiveCodingProfile(selection.Provider, global.LLM.Provider)
	if err != nil {
		return config.LLM{}, err
	}
	profile.Model = selection.Name
	return profile, nil
}

// Environment overrides describe the effective default service. Alternate
// profiles keep their own settings, especially their endpoint and credentials.
func (m *Module) effectiveCodingProfile(provider, defaultProvider string) (config.LLM, error) {
	profile, _, err := m.Settings.Profile(provider)
	if err != nil {
		return config.LLM{}, errors.New("读取所选模型服务失败")
	}
	if provider == defaultProvider {
		profile = config.Effective(config.Settings{LLM: profile}).LLM
	}
	return profile, nil
}

func publicModelOption(llm config.LLM) modelOption {
	return modelOption{Provider: llm.Provider, Model: llm.Model, Available: codingProviderAvailable(llm)}
}

func (m *Module) registerSessionModels(group *gin.RouterGroup) {
	group.GET("/models", m.listSessionModels)
	group.GET("/sessions/:session/model", m.getSessionModel)
	group.PUT("/sessions/:session/model", m.putSessionModel)
}

func (m *Module) listSessionModels(c *gin.Context) {
	settings, err := m.Settings.Get()
	if err != nil {
		pkg.Fail(c, 500, "读取语言模型设置失败")
		return
	}
	providers := make([]modelOption, 0, len(codingModelProviders))
	for _, id := range codingModelProviders {
		llm, err := m.effectiveCodingProfile(id, settings.LLM.Provider)
		if err != nil {
			pkg.Fail(c, 500, err.Error())
			return
		}
		providers = append(providers, publicModelOption(llm))
	}
	pkg.OK(c, gin.H{"default": publicModelOption(settings.LLM), "providers": providers})
}

func (m *Module) getSessionModel(c *gin.Context) {
	session, ok := m.session(c)
	if !ok {
		return
	}
	llm, err := m.resolveSessionLLM(session)
	if err != nil {
		pkg.Fail(c, 500, err.Error())
		return
	}
	pkg.OK(c, resolvedModelSelection{modelSelection: sessionSelection(session), Effective: publicModelOption(llm)})
}

func (m *Module) putSessionModel(c *gin.Context) {
	var input struct {
		Provider *string `json:"model_provider"`
		Name     *string `json:"model_name"`
	}
	if c.ShouldBindJSON(&input) != nil || input.Provider == nil || input.Name == nil {
		pkg.Fail(c, 400, "请选择会话模型或恢复默认设置")
		return
	}
	selection, err := normalizeModelSelection(modelSelection{Provider: *input.Provider, Name: *input.Name})
	if err != nil {
		pkg.Fail(c, 400, err.Error())
		return
	}
	m.sessionsMu.Lock()
	defer m.sessionsMu.Unlock()
	session, ok := m.idleSession(c)
	if !ok {
		return
	}
	if session.Archived {
		pkg.Fail(c, 409, "请先恢复归档会话")
		return
	}
	llm, err := m.resolveSelectedLLM(selection)
	if err != nil {
		pkg.Fail(c, 500, err.Error())
		return
	}
	if selection.Provider != "" {
		if err := codingLLMReady(llm); err != nil {
			pkg.Fail(c, 409, err.Error())
			return
		}
	}
	if err := m.DB.Model(&session).Updates(map[string]any{"model_provider": selection.Provider, "model_name": selection.Name}).Error; err != nil {
		pkg.Fail(c, 500, "保存会话模型失败")
		return
	}
	pkg.OK(c, resolvedModelSelection{modelSelection: selection, Effective: publicModelOption(llm)})
}
