package settings

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/gin-gonic/gin"
	"server/internal/config"
	"server/internal/pkg"
)

// ScreenModel reuses the saved service address and credentials with an independent model name.
type ScreenModel struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
}

type ScreenWatchModels struct {
	Fast   *ScreenModel `json:"fast,omitempty"`
	Vision *ScreenModel `json:"vision,omitempty"`
}

func (s *Service) ScreenWatchModels() (ScreenWatchModels, error) {
	v, err := s.load()
	return v.ScreenWatch, err
}

func (s *Service) ResolveScreenModel(entry *ScreenModel, active config.LLM) (config.LLM, error) {
	if entry == nil {
		return config.LLM{}, fmt.Errorf("未配置屏幕模型")
	}
	profile := active
	if entry.Provider != active.Provider {
		var err error
		profile, _, err = s.Profile(entry.Provider)
		if err != nil {
			return config.LLM{}, err
		}
	}
	profile.Model = entry.Model
	profile.ToolsEnabled = false
	return profile, nil
}

func (s *Service) saveScreenWatch(models ScreenWatchModels) error {
	for _, model := range []*ScreenModel{models.Fast, models.Vision} {
		if model == nil {
			continue
		}
		model.Model = strings.TrimSpace(model.Model)
		if _, ok := config.LLMProviderDefaults(model.Provider); !ok || model.Model == "" || len(model.Model) > 200 {
			return fmt.Errorf("请选择模型服务并填写有效的模型名称")
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.load()
	if err != nil {
		return err
	}
	current.ScreenWatch = models
	data, err := json.Marshal(current)
	if err != nil {
		return err
	}
	return s.db.Save(&Record{ID: 1, Value: string(data)}).Error
}

func (m *Module) getScreenWatch(c *gin.Context) {
	models, err := m.Service.ScreenWatchModels()
	if err != nil {
		pkg.Fail(c, 500, "读取观看模型配置失败")
		return
	}
	pkg.OK(c, models)
}

func (m *Module) saveScreenWatch(c *gin.Context) {
	var models ScreenWatchModels
	if c.ShouldBindJSON(&models) != nil {
		pkg.Fail(c, 400, "观看模型配置格式无效")
		return
	}
	if err := m.Service.saveScreenWatch(models); err != nil {
		pkg.Fail(c, 400, err.Error())
		return
	}
	pkg.OK(c, models)
}
