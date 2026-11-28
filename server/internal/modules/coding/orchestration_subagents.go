// orchestration_subagents.go 负责子 Agent 定义的读取、保存与重置。
package coding

import (
	"context"
	"errors"
	"regexp"
	"slices"
	"strings"

	"server/internal/pkg"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm/clause"
)

type codingSubagent struct {
	Name          string `gorm:"primaryKey" json:"name"`
	Label         string `json:"label"`
	Instructions  string `json:"instructions"`
	Enabled       bool   `json:"enabled"`
	Builtin       bool   `gorm:"-" json:"builtin"`
	ModelProvider string `gorm:"not null;default:''" json:"model_provider"`
	ModelName     string `gorm:"not null;default:''" json:"model_name"`
}

var subagentName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,47}$`)

var builtinSubagentNames = map[string]string{
	"explorer":      "代码探索",
	"code-reviewer": "代码审查",
	"test-runner":   "测试核查",
}

func (m *Module) subagentDefinitions() ([]codingSubagent, error) {
	items := make(map[string]codingSubagent)
	for name, label := range builtinSubagentNames {
		items[name] = codingSubagent{Name: name, Label: label, Instructions: delegateRoles[name], Builtin: true, Enabled: true}
	}
	var stored []codingSubagent
	if err := m.DB.Order("name").Limit(48).Find(&stored).Error; err != nil {
		return nil, err
	}
	for _, item := range stored {
		_, item.Builtin = builtinSubagentNames[item.Name]
		items[item.Name] = item
	}
	result := make([]codingSubagent, 0, len(items))
	for _, item := range items {
		result = append(result, item)
	}
	slices.SortFunc(result, func(a, b codingSubagent) int {
		if a.Builtin != b.Builtin {
			if a.Builtin {
				return -1
			}
			return 1
		}
		return strings.Compare(a.Name, b.Name)
	})
	return result, nil
}

func (m *Module) subagentDefinition(name string) (codingSubagent, error) {
	if name == "worker" {
		return codingSubagent{Instructions: delegateRoles["worker"]}, nil
	}
	definitions, err := m.subagentDefinitions()
	if err != nil {
		return codingSubagent{}, errors.New("读取子 Agent 定义失败")
	}
	for _, item := range definitions {
		if item.Name == name && item.Enabled {
			return item, nil
		}
	}
	return codingSubagent{}, errors.New("此子 Agent 不存在或已停用")
}

type orchestrationToolCatalog struct {
	Agents []string `json:"agents"`
}

// orchestrationCatalog 为代理模式生成可委派的子 Agent 列表；工作会话即使被用户直接打开也不会拿到这些工具。
func (m *Module) orchestrationCatalog(ctx context.Context, session string) *orchestrationToolCatalog {
	if delegatedContext(ctx) || isWorkerSession(m.DB, session) {
		return nil
	}
	items, err := m.subagentDefinitions()
	if err != nil {
		return nil
	}
	result := &orchestrationToolCatalog{Agents: []string{}}
	for _, item := range items {
		if item.Enabled {
			result.Agents = append(result.Agents, item.Name)
		}
	}
	return result
}

func (m *Module) listSubagents(c *gin.Context) {
	items, err := m.subagentDefinitions()
	if err != nil {
		pkg.Fail(c, 500, "读取子 Agent 定义失败")
		return
	}
	pkg.OK(c, items)
}

func (m *Module) putSubagent(c *gin.Context) {
	name := c.Param("name")
	var input struct {
		Label         string `json:"label"`
		Instructions  string `json:"instructions"`
		Enabled       *bool  `json:"enabled"`
		ModelProvider string `json:"model_provider"`
		ModelName     string `json:"model_name"`
	}
	if !subagentName.MatchString(name) || name == "worker" || c.ShouldBindJSON(&input) != nil || input.Enabled == nil ||
		!validOrchestrationText(input.Label, 80) || !validOrchestrationText(input.Instructions, 6000) {
		pkg.Fail(c, 400, "子 Agent 需要有效的标识、显示名称和说明")
		return
	}
	selection, err := normalizeModelSelection(modelSelection{Provider: input.ModelProvider, Name: input.ModelName})
	if err != nil {
		pkg.Fail(c, 400, err.Error())
		return
	}
	if selection.Provider != "" && *input.Enabled {
		llm, err := m.resolveSelectedLLM(selection)
		if err != nil {
			pkg.Fail(c, 500, err.Error())
			return
		}
		if err := codingLLMReady(llm); err != nil {
			pkg.Fail(c, 409, err.Error())
			return
		}
	}
	item := codingSubagent{Name: name, Label: strings.TrimSpace(input.Label), Instructions: strings.TrimSpace(input.Instructions),
		Enabled: *input.Enabled, ModelProvider: selection.Provider, ModelName: selection.Name}
	_, item.Builtin = builtinSubagentNames[name]
	m.sessionsMu.Lock()
	defer m.sessionsMu.Unlock()
	var count, exists int64
	if err := m.DB.Model(&codingSubagent{}).Count(&count).Error; err != nil {
		pkg.Fail(c, 500, "读取子 Agent 数量失败")
		return
	}
	if err := m.DB.Model(&codingSubagent{}).Where("name = ?", name).Count(&exists).Error; err != nil {
		pkg.Fail(c, 500, "读取子 Agent 失败")
		return
	}
	if count >= 48 && exists == 0 {
		pkg.Fail(c, 409, "保存的子 Agent 已达上限")
		return
	}
	if err := m.DB.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "name"}}, DoUpdates: clause.AssignmentColumns([]string{
		"label", "instructions", "enabled", "model_provider", "model_name",
	})}).Create(&item).Error; err != nil {
		pkg.Fail(c, 500, "保存子 Agent 失败")
		return
	}
	pkg.OK(c, item)
}

func (m *Module) resetSubagent(c *gin.Context) {
	name := c.Param("name")
	if !subagentName.MatchString(name) || name == "worker" {
		pkg.Fail(c, 400, "子 Agent 标识无效")
		return
	}
	if err := m.DB.Delete(&codingSubagent{}, "name = ?", name).Error; err != nil {
		pkg.Fail(c, 500, "删除子 Agent 定义失败")
		return
	}
	pkg.OK(c, nil)
}
