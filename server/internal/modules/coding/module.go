// Package coding 提供 PI 编码工作台的后端能力：项目与文件读写、编码会话、交互终端、浏览器调试、
// Goal 与子 Agent 编排，以及插件工作区等。
package coding

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"server/internal/middleware"
	"server/internal/model"
	"server/internal/modules/piplugins"
	"server/internal/modules/settings"
	"server/internal/pkg"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Module 是编码工作台的模块入口，聚合数据库、设置、运行时目录以及终端与浏览器调试服务。
type Module struct {
	DB                *gorm.DB
	Settings          *settings.Service
	RuntimeDir        string
	StateDir          string
	DesktopAvailable  func() bool
	PickDirectory     func() (string, error)
	PluginEnabled     func(string) bool
	Plugins           *piplugins.Module
	Terminal          *TerminalService
	BrowserDebug      *BrowserDebugService
	active            sync.Map   // 以项目 ID 记录前台生成任务，保证同一项目同时只有一次写入。
	filesMu           sync.Mutex // 串行化文件写入与文件条目变更，避免共享临时文件或目录状态被并发修改。
	sessionsMu        sync.Mutex // 串行化会话变更与任务受理，避免前台和后台争抢同一会话。
	orchestrationJobs sync.Map   // 以会话 ID 记录后台 Goal/子 Agent 任务，用于并发限额与取消。
}

type runningTask struct {
	sessionID string
	cancel    context.CancelFunc
}

// Register 在给定路由组上注册编码工作台的全部 HTTP 接口，并统一挂载工作区校验中间件。
func (m *Module) Register(r *gin.RouterGroup) {
	group := r.Group("/coding", middleware.WorkspaceOnly(m.DesktopAvailable))
	group.GET("/runtime", m.runtimeStatus)
	group.GET("/enhancements", m.getEnhancements)
	group.PUT("/enhancements", m.putEnhancements)
	group.POST("/enhancements/rewrite", m.rewritePrompt)
	group.GET("/enhancements/memory", m.listCodingMemories)
	group.POST("/enhancements/memory", m.saveCodingMemory)
	group.DELETE("/enhancements/memory/:memory", m.deleteCodingMemory)
	group.GET("/projects", m.projects)
	group.POST("/projects", m.addProject)
	group.POST("/pick-directory", m.pickDirectory)
	group.GET("/projects/:project/files", m.files)
	group.POST("/projects/:project/files/action", m.fileAction)
	group.GET("/projects/:project/search", m.search)
	group.GET("/projects/:project/preview", m.mediaPreview)
	group.GET("/projects/:project/sqlite", m.sqlitePreview)
	group.GET("/projects/:project/file", m.file)
	group.PUT("/projects/:project/file", m.saveFile)
	group.GET("/projects/:project/changes", m.changes)
	group.GET("/projects/:project/sessions", m.sessions)
	group.POST("/projects/:project/sessions", m.newSession)
	group.PUT("/sessions/:session", m.updateSession)
	group.POST("/sessions/:session/fork", m.forkSession)
	group.POST("/sessions/:session/suggestion", m.suggestPrompt)
	group.GET("/sessions/:session/messages", m.messages)
	group.POST("/sessions/:session/messages", m.prompt)
	group.POST("/sessions/:session/stop", m.stop)
	m.registerTerminal(group)
	m.registerBrowserDebug(group)
	m.registerOrchestration(group)
	m.registerSessionModels(group)
}

func (m *Module) runtimeStatus(c *gin.Context) {
	_, _, err := m.runtimePaths()
	result := gin.H{"ready": err == nil}
	if err != nil {
		result["message"] = err.Error()
	}
	pkg.OK(c, result)
}

func (m *Module) projects(c *gin.Context) {
	projects := []model.CodingProject{}
	if err := m.DB.Order("created_at asc").Find(&projects).Error; err != nil {
		pkg.Fail(c, 500, "读取项目失败")
		return
	}
	pkg.OK(c, projects)
}

func (m *Module) addProject(c *gin.Context) {
	var input struct {
		Path string `json:"path"`
	}
	if c.ShouldBindJSON(&input) != nil || !filepath.IsAbs(input.Path) {
		pkg.Fail(c, 400, "请选择项目绝对路径")
		return
	}
	path, err := filepath.EvalSymlinks(input.Path)
	if err != nil {
		pkg.Fail(c, 400, "无法打开项目目录")
		return
	}
	if filepath.Dir(path) == path {
		pkg.Fail(c, 400, "请选择一个项目文件夹")
		return
	}
	root, err := os.OpenRoot(path)
	if err != nil {
		pkg.Fail(c, 400, "无法打开项目目录")
		return
	}
	root.Close()
	project := model.CodingProject{ID: uuid.NewString(), Path: path, Name: filepath.Base(path)}
	if err := m.DB.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "path"}}, DoNothing: true}).Create(&project).Error; err != nil {
		pkg.Fail(c, 500, "保存项目失败")
		return
	}
	project = model.CodingProject{}
	if err := m.DB.First(&project, "path = ?", path).Error; err != nil {
		pkg.Fail(c, 500, "读取项目失败")
		return
	}
	pkg.OK(c, project)
}

func (m *Module) pickDirectory(c *gin.Context) {
	if m.PickDirectory == nil || m.DesktopAvailable == nil || !m.DesktopAvailable() {
		pkg.Fail(c, 409, "目录选择器需要桌面客户端")
		return
	}
	path, err := m.PickDirectory()
	if err != nil {
		pkg.Fail(c, 500, "打开目录选择器失败")
		return
	}
	pkg.OK(c, gin.H{"path": path})
}

func (m *Module) project(c *gin.Context, id string) (model.CodingProject, bool) {
	var project model.CodingProject
	if err := m.DB.First(&project, "id = ?", id).Error; err != nil {
		resourceError(c, err, "项目")
		return project, false
	}
	return project, true
}

func resourceError(c *gin.Context, err error, name string) {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		pkg.Fail(c, 404, name+"不存在")
	} else {
		pkg.Fail(c, 500, "读取"+name+"失败")
	}
}

func (m *Module) openProject(c *gin.Context, id string) *os.Root {
	project, ok := m.project(c, id)
	if !ok {
		return nil
	}
	root, err := os.OpenRoot(project.Path)
	if err != nil {
		pkg.Fail(c, 409, "无法打开项目目录，请检查目录是否已移动")
		return nil
	}
	return root
}

func (m *Module) files(c *gin.Context) {
	root := m.openProject(c, c.Param("project"))
	if root == nil {
		return
	}
	defer root.Close()
	entries, err := listFiles(root, c.Query("path"))
	if err != nil {
		pkg.Fail(c, 400, err.Error())
		return
	}
	pkg.OK(c, entries)
}

func (m *Module) file(c *gin.Context) {
	root := m.openProject(c, c.Param("project"))
	if root == nil {
		return
	}
	defer root.Close()
	file, err := readFile(root, c.Query("path"))
	if err != nil {
		pkg.Fail(c, 400, err.Error())
		return
	}
	pkg.OK(c, file)
}

func (m *Module) saveFile(c *gin.Context) {
	root := m.openProject(c, c.Param("project"))
	if root == nil {
		return
	}
	defer root.Close()
	var input struct {
		Path string `json:"path"`
		fileContent
	}
	if c.ShouldBindJSON(&input) != nil {
		pkg.Fail(c, 400, "文件参数无效")
		return
	}
	file, err := m.writeFile(root, input.Path, input.fileContent)
	if errors.Is(err, errStaleFile) {
		pkg.Fail(c, 409, err.Error())
		return
	}
	if err != nil {
		pkg.Fail(c, 400, err.Error())
		return
	}
	pkg.OK(c, file)
}

func (m *Module) sessions(c *gin.Context) {
	if _, ok := m.project(c, c.Param("project")); !ok {
		return
	}
	sessions := []model.CodingSession{}
	if err := m.DB.Where("project_id = ?", c.Param("project")).Order("updated_at desc").Find(&sessions).Error; err != nil {
		pkg.Fail(c, 500, "读取编码会话失败")
		return
	}
	pkg.OK(c, sessions)
}

func (m *Module) newSession(c *gin.Context) {
	project, ok := m.project(c, c.Param("project"))
	if !ok {
		return
	}
	session := model.CodingSession{ID: uuid.NewString(), ProjectID: project.ID, Title: "新会话"}
	if err := m.DB.Create(&session).Error; err != nil {
		pkg.Fail(c, 500, "创建编码会话失败")
		return
	}
	pkg.OK(c, session)
}

func (m *Module) session(c *gin.Context) (model.CodingSession, bool) {
	var session model.CodingSession
	if err := m.DB.First(&session, "id = ?", c.Param("session")).Error; err != nil {
		resourceError(c, err, "编码会话")
		return session, false
	}
	return session, true
}

func (m *Module) messages(c *gin.Context) {
	session, ok := m.session(c)
	if !ok {
		return
	}
	messages := []model.CodingMessage{}
	if err := m.DB.Where("session_id = ?", session.ID).Order("id asc").Find(&messages).Error; err != nil {
		pkg.Fail(c, 500, "读取编码对话失败")
		return
	}
	pkg.OK(c, messages)
}

func (m *Module) stop(c *gin.Context) {
	session, ok := m.session(c)
	if !ok {
		return
	}
	if value, exists := m.active.Load(session.ProjectID); exists {
		task := value.(runningTask)
		if task.sessionID == session.ID {
			task.cancel()
		}
	}
	pkg.OK(c, nil)
}

// reservePrompt 在会话锁内完成校验与占位，确保同一项目不会并行启动前台生成。
func (m *Module) reservePrompt(c *gin.Context, cancel context.CancelFunc) (model.CodingSession, bool) {
	m.sessionsMu.Lock()
	defer m.sessionsMu.Unlock()
	session, ok := m.session(c)
	if !ok {
		return session, false
	}
	if session.Archived {
		pkg.Fail(c, 409, "请先恢复归档会话")
		return session, false
	}
	if m.orchestrationBusy(session.ID) {
		pkg.Fail(c, 409, "此会话已有 Goal 或子 Agent 任务")
		return session, false
	}
	if _, exists := m.active.LoadOrStore(session.ProjectID, runningTask{session.ID, cancel}); exists {
		pkg.Fail(c, 409, "这个项目已有编码任务正在运行")
		return session, false
	}
	return session, true
}

func (m *Module) prompt(c *gin.Context) {
	var input struct {
		Text string `json:"text"`
		Mode string `json:"mode"`
	}
	if c.ShouldBindJSON(&input) != nil || strings.TrimSpace(input.Text) == "" || utf8.RuneCountInString(input.Text) > 16000 || (input.Mode != "plan" && input.Mode != "agent") {
		pkg.Fail(c, 400, "请输入 1–16000 字的编码任务并选择工作模式")
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 4*time.Minute)
	defer cancel()
	session, ok := m.reservePrompt(c, cancel)
	if !ok {
		return
	}
	defer m.active.Delete(session.ProjectID)
	if input.Mode == "agent" {
		canEdit, err := m.workerEditAllowed(session.ID)
		if err != nil {
			pkg.Fail(c, 500, "读取工作会话权限失败")
			return
		}
		if !canEdit {
			pkg.Fail(c, 409, "此工作会话已设为只读")
			return
		}
	}
	root := m.openProject(c, session.ProjectID)
	if root == nil {
		return
	}
	defer root.Close()
	if _, _, err := m.runtimePaths(); err != nil {
		pkg.Fail(c, 503, err.Error())
		return
	}
	llm, err := m.resolveSessionLLM(session)
	if err != nil {
		pkg.Fail(c, 500, err.Error())
		return
	}
	if err := codingLLMReady(llm); err != nil {
		pkg.Fail(c, 400, err.Error())
		return
	}
	user := model.CodingMessage{SessionID: session.ID, Role: "user", Status: "complete", Content: strings.TrimSpace(input.Text)}
	assistant := model.CodingMessage{SessionID: session.ID, Role: "assistant", Status: "streaming"}
	enhancements := model.CodingEnhancements{}
	if m.PluginEnabled != nil && m.PluginEnabled(enhancementPlugin) {
		enhancements, _ = m.enhancementSettings()
	}
	autoTitle := session.Title == "新会话" && enhancements.Titles
	err = m.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&user).Error; err != nil {
			return err
		}
		if err := tx.Create(&assistant).Error; err != nil {
			return err
		}
		if autoTitle {
			title := []rune(strings.Join(strings.Fields(user.Content), " "))
			session.Title = string(title[:min(40, len(title))])
		}
		return tx.Model(&session).Updates(map[string]any{"title": session.Title, "updated_at": time.Now()}).Error
	})
	if err != nil {
		pkg.Fail(c, 500, "保存编码对话失败")
		return
	}
	// 用 SSE 逐段推送生成内容；禁用代理缓冲，避免增量被攒批而前端迟迟看不到输出。
	c.Header("Content-Type", "text/event-stream; charset=utf-8")
	c.Header("X-Accel-Buffering", "no")
	write := func(event any) error {
		data, err := json.Marshal(event)
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(c.Writer, "data: %s\n\n", data); err != nil {
			return err
		}
		c.Writer.Flush()
		return nil
	}
	var answer strings.Builder
	err = write(gin.H{"type": "started", "title": session.Title})
	if err == nil {
		err = m.runPi(ctx, root, llm, session.ProjectID, session.ID, input.Mode, user.Content, enhancements, func(event runtimeEvent) error {
			if event.Type == "delta" {
				if answer.Len()+len(event.Text) > 512<<10 {
					return errors.New("本轮回复超出长度限制")
				}
				answer.WriteString(event.Text)
			}
			if event.Type == "tool" {
				assistant.Tools = append(assistant.Tools, model.CodingToolRun{Name: event.Name, Path: event.Path})
			}
			return write(event)
		})
	}
	assistant.Content = answer.String()
	assistant.Status = "complete"
	if errors.Is(ctx.Err(), context.Canceled) {
		assistant.Status = "interrupted"
	} else if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		assistant.Status, assistant.Error = "failed", "编码任务已超时"
	} else if err != nil {
		assistant.Status, assistant.Error = "failed", err.Error()
	}
	if err := m.DB.Model(&assistant).Select("content", "status", "error", "tools").Updates(&assistant).Error; err != nil {
		_ = write(gin.H{"type": "error", "text": "保存回复失败"})
		return
	}
	if autoTitle && enhancements.ModelTitles && assistant.Status == "complete" && strings.TrimSpace(assistant.Content) != "" {
		title, err := m.completeEnhancement(ctx, "Summarize the first exchange as a short coding session title in the user's language. Return only the title.", clipRunes(user.Content, 600)+"\n"+clipRunes(assistant.Content, 600), 200, 5*time.Second)
		title = clipRunes(strings.Join(strings.Fields(title), " "), 40)
		if err == nil && title != "" {
			result := m.DB.Model(&model.CodingSession{}).Where("id = ? AND title = ?", session.ID, session.Title).Update("title", title)
			if result.Error == nil && result.RowsAffected > 0 {
				_ = write(gin.H{"type": "started", "title": title})
			}
		}
	}
	if c.Request.Context().Err() == nil {
		_ = write(gin.H{"type": "done", "message": assistant})
	}
}
