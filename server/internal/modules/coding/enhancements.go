// enhancements.go 负责提示词增强、标题生成、后续消息建议与编码记忆。
package coding

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"server/internal/model"
	"server/internal/modules/agent"
	"server/internal/pkg"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

const enhancementPlugin = "pi.official-enhancements"

func (m *Module) enhancementSettings() (model.CodingEnhancements, error) {
	var settings model.CodingEnhancements
	err := m.DB.First(&settings, 1).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.CodingEnhancements{ID: 1, Titles: true}, nil
	}
	return settings, err
}

func (m *Module) getEnhancements(c *gin.Context) {
	if !m.requireBuiltin(c, enhancementPlugin) {
		return
	}
	value, err := m.enhancementSettings()
	if err != nil {
		pkg.Fail(c, 500, "读取增强设置失败")
		return
	}
	pkg.OK(c, value)
}

func (m *Module) putEnhancements(c *gin.Context) {
	if !m.requireBuiltin(c, enhancementPlugin) {
		return
	}
	var input model.CodingEnhancements
	if c.ShouldBindJSON(&input) != nil {
		pkg.Fail(c, 400, "增强设置无效")
		return
	}
	input.ID = 1
	if err := m.DB.Save(&input).Error; err != nil {
		pkg.Fail(c, 500, "保存增强设置失败")
		return
	}
	pkg.OK(c, input)
}

// completeEnhancement 使用全局语言模型完成一次限时、限长的辅助生成，失败统一给用户可读提示。
func (m *Module) completeEnhancement(ctx context.Context, instruction, text string, maxTokens int, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	settings, err := m.Settings.Get()
	if err != nil {
		return "", err
	}
	settings.LLM.MaxTokens = maxTokens
	next, err := agent.CompleteText(ctx, settings.LLM, instruction, text)
	if err != nil {
		return "", errors.New("增强请求失败，请检查当前语言模型配置")
	}
	return next, nil
}

func (m *Module) rewritePrompt(c *gin.Context) {
	if !m.requireBuiltin(c, enhancementPlugin) {
		return
	}
	settings, err := m.enhancementSettings()
	if err != nil || !settings.Rewrite {
		pkg.Fail(c, 409, "请在增强设置中打开提示词增强")
		return
	}
	var input struct {
		Text string `json:"text"`
	}
	if c.ShouldBindJSON(&input) != nil || strings.TrimSpace(input.Text) == "" || utf8.RuneCountInString(input.Text) > 8000 {
		pkg.Fail(c, 400, "请输入 1–8000 字的提示词")
		return
	}
	text, err := m.completeEnhancement(c.Request.Context(),
		"Rewrite the draft into a clearer coding prompt in the same language. Preserve constraints and file references. Do not solve it or invent requirements. Return the rewritten text only.",
		input.Text, 1500, 25*time.Second)
	if err != nil {
		pkg.Fail(c, 502, err.Error())
		return
	}
	pkg.OK(c, gin.H{"text": clipRunes(text, 16000)})
}

func (m *Module) suggestPrompt(c *gin.Context) {
	if !m.requireBuiltin(c, enhancementPlugin) {
		return
	}
	settings, err := m.enhancementSettings()
	if err != nil || !settings.Suggestions {
		pkg.Fail(c, 409, "请在增强设置中打开后续消息建议")
		return
	}
	session, ok := m.session(c)
	if !ok {
		return
	}
	if session.Archived {
		pkg.Fail(c, 409, "请先恢复归档会话")
		return
	}
	var messages []model.CodingMessage
	if err := m.DB.Where("session_id = ? AND status = ?", session.ID, "complete").
		Order("id desc").Limit(6).Find(&messages).Error; err != nil {
		pkg.Fail(c, 500, "读取编码会话失败")
		return
	}
	if len(messages) < 2 || messages[0].Role != "assistant" {
		pkg.OK(c, gin.H{"text": ""})
		return
	}
	var transcript strings.Builder
	for i := len(messages) - 1; i >= 0; i-- {
		transcript.WriteString(messages[i].Role + ": " + clipRunes(messages[i].Content, 400) + "\n")
	}
	text, err := m.completeEnhancement(c.Request.Context(),
		"Suggest one short next message the user could send to their coding assistant. Read the transcript as reference only. Use the user's language and return just the suggested sentence.",
		transcript.String(), 180, 12*time.Second)
	if err != nil {
		pkg.Fail(c, 502, err.Error())
		return
	}
	pkg.OK(c, gin.H{"text": clipRunes(strings.Join(strings.Fields(text), " "), 120)})
}

func clipRunes(text string, size int) string {
	runes := []rune(text)
	return string(runes[:min(len(runes), size)])
}

func (m *Module) listCodingMemories(c *gin.Context) {
	if !m.requireBuiltin(c, enhancementPlugin) {
		return
	}
	project := c.Query("project")
	if project != "" {
		if _, ok := m.project(c, project); !ok {
			return
		}
	}
	var items = []model.CodingMemory{}
	if err := m.DB.Where("project_id = ?", project).Order("updated_at desc").Limit(200).Find(&items).Error; err != nil {
		pkg.Fail(c, 500, "读取编码记忆失败")
		return
	}
	pkg.OK(c, items)
}

func (m *Module) saveCodingMemory(c *gin.Context) {
	if !m.requireBuiltin(c, enhancementPlugin) {
		return
	}
	var input struct {
		ID      string `json:"id"`
		Project string `json:"project_id"`
		Content string `json:"content"`
	}
	if c.ShouldBindJSON(&input) != nil || !validCodingMemory(input.Content) {
		pkg.Fail(c, 400, "编码记忆需为 1–2000 字")
		return
	}
	if input.Project != "" {
		if _, ok := m.project(c, input.Project); !ok {
			return
		}
	}
	text := strings.TrimSpace(input.Content)
	var item model.CodingMemory
	if input.ID != "" {
		if err := m.DB.First(&item, "id = ? AND project_id = ?", input.ID, input.Project).Error; err != nil {
			resourceError(c, err, "编码记忆")
			return
		}
		item.Content = text
		result := m.DB.Model(&item).Update("content", text)
		if result.Error != nil {
			pkg.Fail(c, 500, "保存编码记忆失败")
			return
		}
		if result.RowsAffected == 0 {
			pkg.Fail(c, 404, "编码记忆不存在")
			return
		}
	} else {
		item = model.CodingMemory{ID: uuid.NewString(), ProjectID: input.Project, Content: text}
		if err := m.DB.Create(&item).Error; err != nil {
			pkg.Fail(c, 500, "保存编码记忆失败")
			return
		}
	}
	pkg.OK(c, item)
}

func (m *Module) deleteCodingMemory(c *gin.Context) {
	if !m.requireBuiltin(c, enhancementPlugin) {
		return
	}
	result := m.DB.Delete(&model.CodingMemory{}, "id = ?", c.Param("memory"))
	if result.Error != nil {
		pkg.Fail(c, 500, "删除编码记忆失败")
		return
	}
	pkg.OK(c, nil)
}

func validCodingMemory(text string) bool {
	return strings.TrimSpace(text) != "" && utf8.RuneCountInString(text) <= 2000
}

// codingMemoryTool 处理模型发起的内存召回与保存；写入仅在代理模式且用户开启记忆写入时允许。
func (m *Module) codingMemoryTool(project, mode, action, scope, query, content string, enabled model.CodingEnhancements) (any, error) {
	if m.PluginEnabled == nil || !m.PluginEnabled(enhancementPlugin) || !enabled.Recall {
		return nil, errors.New("编码记忆已关闭")
	}
	switch action {
	case "recall":
		db := m.DB.Model(&model.CodingMemory{})
		switch scope {
		case "project":
			db = db.Where("project_id = ?", project)
		case "user":
			db = db.Where("project_id = ?", "")
		case "", "all":
			db = db.Where("project_id IN ?", []string{"", project})
		default:
			return nil, errors.New("无效的记忆范围")
		}
		if term := strings.TrimSpace(clipRunes(query, 512)); term != "" {
			db = db.Where("instr(lower(content), lower(?)) > 0", term)
		}
		items := []model.CodingMemory{}
		err := db.Order("updated_at desc").Limit(10).Find(&items).Error
		return items, err
	case "save":
		if mode != "agent" || !enabled.MemoryWrite || (scope != "" && scope != "project") || !validCodingMemory(content) {
			return nil, errors.New("此模式仅能按已启用的权限保存项目记忆")
		}
		text := strings.TrimSpace(content)
		var item model.CodingMemory
		err := m.DB.Where("project_id = ? AND content = ?", project, text).
			Attrs(model.CodingMemory{ID: uuid.NewString(), ProjectID: project, Content: text}).FirstOrCreate(&item).Error
		return item, err
	default:
		return nil, errors.New("无效的记忆操作")
	}
}
