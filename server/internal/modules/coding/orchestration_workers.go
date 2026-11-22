package coding

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"time"

	"server/internal/config"
	"server/internal/model"
	"server/internal/pkg"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

type codingWorker struct {
	ID            string    `gorm:"primaryKey" json:"id"`
	ParentID      string    `gorm:"index" json:"parent_id"`
	ProjectID     string    `json:"project_id"`
	Kind          string    `json:"kind"`
	Role          string    `json:"role"`
	Instructions  string    `json:"-"`
	Mode          string    `json:"mode"`
	Task          string    `json:"task"`
	Status        string    `json:"status"`
	Result        string    `json:"result,omitempty"`
	Error         string    `json:"error,omitempty"`
	Turns         int       `json:"turns"`
	Accepted      bool      `json:"accepted"`
	ModelProvider string    `gorm:"-" json:"model_provider"`
	ModelName     string    `gorm:"-" json:"model_name"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

var delegateRoles = map[string]string{
	"explorer":      "Survey the relevant project files and map how the code works. Return concrete paths, findings, and any gaps.",
	"code-reviewer": "Perform a read-only correctness and maintainability review of the requested area. Rank reproducible findings and supporting paths.",
	"test-runner":   "Inspect the project's test configuration, test cases and any existing test output files as requested. Return observed test evidence and a concise validation plan. Claim only testing you can verify.",
	"worker":        "Work on the assigned part of the current project in a separate session. Report concrete findings, changes, and verification.",
}

func isWorkerSession(db *gorm.DB, session string) bool {
	var count int64
	return db.Model(&codingWorker{}).Where("id = ?", session).Count(&count).Error == nil && count > 0
}

// Prevent a foreground prompt from widening a persisted read-only worker.
func (m *Module) workerEditAllowed(session string) (bool, error) {
	var worker codingWorker
	err := m.DB.First(&worker, "id = ?", session).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return true, nil
	}
	return worker.Mode == "agent", err
}

func (m *Module) listWorkers(c *gin.Context) {
	session, ok := m.session(c)
	if !ok {
		return
	}
	items, err := m.workerList(session.ID)
	if err != nil {
		pkg.Fail(c, 500, "读取工作会话失败")
		return
	}
	pkg.OK(c, items)
}

func (m *Module) sessionOrchestrationStatus(c *gin.Context) {
	session, ok := m.session(c)
	if !ok {
		return
	}
	var worker codingWorker
	var item *codingWorker
	err := m.DB.First(&worker, "id = ?", session.ID).Error
	if err == nil {
		worker.ModelProvider, worker.ModelName = session.ModelProvider, session.ModelName
		item = &worker
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		pkg.Fail(c, 500, "读取工作会话状态失败")
		return
	}
	pkg.OK(c, gin.H{"active": m.orchestrationBusy(session.ID), "worker": item})
}

func (m *Module) workerList(parent string) ([]codingWorker, error) {
	records := []codingWorker{}
	if err := m.DB.Where("parent_id = ?", parent).Order("created_at desc").Limit(30).Find(&records).Error; err != nil || len(records) == 0 {
		return records, err
	}
	ids := make([]string, 0, len(records))
	for i := range records {
		ids = append(ids, records[i].ID)
	}
	var sessions []model.CodingSession
	if err := m.DB.Select("id", "model_provider", "model_name").Where("id IN ?", ids).Find(&sessions).Error; err != nil {
		return nil, err
	}
	selections := make(map[string]modelSelection, len(sessions))
	for _, session := range sessions {
		selections[session.ID] = sessionSelection(session)
	}
	for i := range records {
		selection := selections[records[i].ID]
		records[i].ModelProvider, records[i].ModelName = selection.Provider, selection.Name
	}
	return records, nil
}

func (m *Module) createWorker(c *gin.Context) {
	var input struct {
		Role string `json:"role"`
		Mode string `json:"mode"`
		Task string `json:"task"`
		modelSelection
	}
	if c.ShouldBindJSON(&input) != nil || !validOrchestrationText(input.Task, 12000) ||
		(input.Mode != "plan" && input.Mode != "agent") || !subagentName.MatchString(input.Role) ||
		(input.Mode == "agent" && input.Role != "worker") {
		pkg.Fail(c, 400, "请选择工作类型并填写任务，子 Agent 只能读取项目")
		return
	}
	parent, ok := orchestrationSession(c, m)
	if !ok {
		return
	}
	selection, err := normalizeModelSelection(input.modelSelection)
	if err != nil {
		pkg.Fail(c, 400, err.Error())
		return
	}
	kind := "worker"
	if input.Role != "worker" {
		kind = "subagent"
	}
	worker, _, err := m.spawnWorker(context.Background(), parent, selection, kind, input.Role, input.Mode, strings.TrimSpace(input.Task))
	if err != nil {
		pkg.Fail(c, 409, err.Error())
		return
	}
	pkg.OK(c, worker)
}

func (m *Module) workerAction(c *gin.Context) {
	var input struct {
		Task string `json:"task"`
	}
	action := c.Param("action")
	if action == "send" && (c.ShouldBindJSON(&input) != nil || !validOrchestrationText(input.Task, 12000)) {
		pkg.Fail(c, 400, "请补充 1–12000 字的工作任务")
		return
	}
	session, ok := m.session(c)
	if !ok {
		return
	}
	if action == "send" && session.Archived {
		pkg.Fail(c, 409, "请先恢复归档会话")
		return
	}
	worker, err := m.findWorker(session.ID, c.Param("worker"))
	if err != nil {
		resourceError(c, err, "工作会话")
		return
	}
	switch action {
	case "send":
		worker, _, err = m.continueWorker(context.Background(), worker, strings.TrimSpace(input.Task))
	case "cancel":
		worker, err = m.cancelWorker(worker)
	case "accept":
		worker, err = m.acceptWorker(worker)
	default:
		pkg.Fail(c, 400, "未知的工作会话操作")
		return
	}
	if err != nil {
		pkg.Fail(c, 409, err.Error())
		return
	}
	pkg.OK(c, worker)
}

func (m *Module) findWorker(parent, worker string) (codingWorker, error) {
	var result codingWorker
	if err := m.DB.First(&result, "parent_id = ? AND id = ?", parent, worker).Error; err != nil {
		return result, err
	}
	var session model.CodingSession
	err := m.DB.Select("model_provider", "model_name").First(&session, "id = ?", result.ID).Error
	result.ModelProvider, result.ModelName = session.ModelProvider, session.ModelName
	return result, err
}

func (m *Module) workerRoot(projectID string) (*os.Root, error) {
	var project model.CodingProject
	if err := m.DB.First(&project, "id = ?", projectID).Error; err != nil {
		return nil, errors.New("找不到工作会话的项目")
	}
	root, err := os.OpenRoot(project.Path)
	if err != nil {
		return nil, errors.New("无法打开工作会话的项目目录")
	}
	return root, nil
}

func (m *Module) spawnWorker(ctx context.Context, parent model.CodingSession, selection modelSelection, kind, role, mode, task string) (codingWorker, *orchestrationJob, error) {
	m.sessionsMu.Lock()
	defer m.sessionsMu.Unlock()
	if err := m.DB.First(&parent, "id = ?", parent.ID).Error; err != nil || parent.Archived {
		return codingWorker{}, nil, errors.New("请在未归档的父会话中创建任务")
	}
	if isWorkerSession(m.DB, parent.ID) {
		return codingWorker{}, nil, errors.New("工作会话不能再创建下级任务")
	}
	definition, err := m.subagentDefinition(role)
	if err != nil {
		return codingWorker{}, nil, err
	}
	if selection.Provider == "" {
		selection = sessionSelection(parent)
		if definition.ModelProvider != "" {
			selection = modelSelection{Provider: definition.ModelProvider, Name: definition.ModelName}
		}
	}
	cfg, err := m.orchestrationConfig(selection)
	if err != nil {
		return codingWorker{}, nil, err
	}
	var count int64
	if err := m.DB.Model(&codingWorker{}).Where("parent_id = ?", parent.ID).Count(&count).Error; err != nil || count >= 100 {
		return codingWorker{}, nil, errors.New("此会话的工作会话数量已达上限")
	}
	root, err := m.workerRoot(parent.ProjectID)
	if err != nil {
		return codingWorker{}, nil, err
	}
	worker := codingWorker{ID: uuid.NewString(), ParentID: parent.ID, ProjectID: parent.ProjectID,
		Kind: kind, Role: role, Instructions: definition.Instructions, Mode: mode, Task: task, Status: "running",
		ModelProvider: selection.Provider, ModelName: selection.Name}
	ctx, job, err := m.claimOrchestration(ctx, parent.ProjectID, worker.ID, worker.ID, kind, mode, 4*time.Minute)
	if err != nil {
		_ = root.Close()
		return codingWorker{}, nil, err
	}
	err = m.DB.Transaction(func(tx *gorm.DB) error {
		title := "工作会话"
		if kind == "subagent" {
			title = role
		}
		title += " · " + clipRunes(strings.Join(strings.Fields(task), " "), 45)
		if err := tx.Create(&model.CodingSession{
			ID: worker.ID, ProjectID: parent.ProjectID, Title: title,
			ModelProvider: selection.Provider, ModelName: selection.Name,
		}).Error; err != nil {
			return err
		}
		return tx.Create(&worker).Error
	})
	if err != nil {
		_ = root.Close()
		m.finishOrchestration(job)
		return codingWorker{}, nil, errors.New("无法保存工作会话")
	}
	go m.runWorker(ctx, job, root, cfg, worker, task)
	return worker, job, nil
}

func (m *Module) continueWorker(ctx context.Context, worker codingWorker, task string) (codingWorker, *orchestrationJob, error) {
	m.sessionsMu.Lock()
	defer m.sessionsMu.Unlock()
	var err error
	worker, err = m.findWorker(worker.ParentID, worker.ID)
	if err != nil {
		return codingWorker{}, nil, errors.New("工作会话不存在")
	}
	if worker.Status == "running" || m.orchestrationBusy(worker.ID) {
		return codingWorker{}, nil, errors.New("请等待工作会话结束当前任务")
	}
	var session model.CodingSession
	if err := m.DB.First(&session, "id = ?", worker.ID).Error; err != nil || session.Archived {
		return codingWorker{}, nil, errors.New("请先恢复工作会话")
	}
	cfg, err := m.orchestrationConfig(sessionSelection(session))
	if err != nil {
		return codingWorker{}, nil, err
	}
	root, err := m.workerRoot(worker.ProjectID)
	if err != nil {
		return codingWorker{}, nil, err
	}
	ctx, job, err := m.claimOrchestration(ctx, worker.ProjectID, worker.ID, worker.ID, worker.Kind, worker.Mode, 4*time.Minute)
	if err != nil {
		_ = root.Close()
		return codingWorker{}, nil, err
	}
	worker.Task, worker.Status, worker.Error, worker.Accepted = task, "running", "", false
	if err := m.DB.Model(&worker).Select("task", "status", "error", "accepted", "updated_at").Updates(&worker).Error; err != nil {
		_ = root.Close()
		m.finishOrchestration(job)
		return codingWorker{}, nil, errors.New("无法继续工作会话")
	}
	go m.runWorker(ctx, job, root, cfg, worker, task)
	return worker, job, nil
}

func (m *Module) cancelWorker(worker codingWorker) (codingWorker, error) {
	m.sessionsMu.Lock()
	defer m.sessionsMu.Unlock()
	job := m.orchestrationJob(worker.ID, worker.ID)
	if job == nil || worker.Status != "running" {
		return codingWorker{}, errors.New("此工作会话未在运行")
	}
	worker.Status = "cancelled"
	result := m.DB.Model(&worker).Where("status = ?", "running").Select("status", "updated_at").Updates(&worker)
	if result.Error != nil {
		return codingWorker{}, errors.New("取消工作会话失败")
	}
	if result.RowsAffected == 0 {
		return codingWorker{}, errors.New("此工作会话已经结束")
	}
	job.cancel()
	return worker, nil
}

func (m *Module) acceptWorker(worker codingWorker) (codingWorker, error) {
	if worker.Status != "completed" {
		return codingWorker{}, errors.New("工作会话完成后才能采纳报告")
	}
	result := m.DB.Model(&worker).Where("status = ?", "completed").Update("accepted", true)
	if result.Error != nil || result.RowsAffected == 0 {
		return codingWorker{}, errors.New("工作会话状态已变更")
	}
	worker.Accepted = true
	return worker, nil
}

func (m *Module) runWorker(ctx context.Context, job *orchestrationJob, root *os.Root, cfg config.LLM, worker codingWorker, task string) {
	defer m.finishOrchestration(job)
	defer root.Close()
	instructions := worker.Instructions
	if instructions == "" {
		instructions = delegateRoles[worker.Role]
	}
	message, err := m.backgroundTurn(ctx, root, cfg, worker.ProjectID, worker.ID, worker.Mode,
		instructions+"\n\nUser-authorized task:\n"+task, task)
	worker.Turns++
	worker.Result = clipRunes(strings.TrimSpace(message.Content), 12000)
	switch {
	case ctx.Err() != nil:
		worker.Status, worker.Error = "interrupted", "执行已中断，可继续"
	case err != nil || message.Status != "complete":
		worker.Status, worker.Error = "failed", message.Error
		if worker.Error == "" {
			worker.Error = "工作会话未完成"
		}
	default:
		worker.Status = "completed"
	}
	m.DB.Model(&worker).Where("status = ?", "running").
		Select("status", "result", "error", "turns", "updated_at").Updates(&worker)
}

func (m *Module) runOrchestrationTool(ctx context.Context, project, session, tool string, payload json.RawMessage) (any, error) {
	if delegatedContext(ctx) || isWorkerSession(m.DB, session) {
		return nil, errors.New("工作会话不能再委派任务")
	}
	var input struct {
		Agent  string `json:"agent"`
		Action string `json:"action"`
		ID     string `json:"id"`
		Task   string `json:"task"`
	}
	if json.Unmarshal(payload, &input) != nil {
		return nil, errors.New("任务参数无效")
	}
	parent := model.CodingSession{ID: session, ProjectID: project}
	switch tool {
	case "delegate_task":
		if !validOrchestrationText(input.Task, 6000) || input.Agent == "worker" || !subagentName.MatchString(input.Agent) {
			return nil, errors.New("请选择支持的子 Agent，并填写任务")
		}
		worker, job, err := m.spawnWorker(ctx, parent, modelSelection{}, "subagent", input.Agent, "plan", input.Task)
		if err != nil {
			return nil, err
		}
		return m.waitWorker(ctx, worker, job, false)
	case "session_task":
		return m.runSessionTool(ctx, parent, input.Action, input.ID, input.Task)
	default:
		return nil, errors.New("未知的编排工具")
	}
}

func (m *Module) waitWorker(ctx context.Context, worker codingWorker, job *orchestrationJob, short bool) (any, error) {
	if job != nil {
		if short {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, 15*time.Second)
			defer cancel()
		}
		select {
		case <-ctx.Done():
			if short && errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return gin.H{"id": worker.ID, "status": "running", "timed_out": true}, nil
			}
			return nil, ctx.Err()
		case <-job.done:
		}
	}
	return m.findWorker(worker.ParentID, worker.ID)
}

func (m *Module) runSessionTool(ctx context.Context, parent model.CodingSession, action, id, task string) (any, error) {
	switch action {
	case "list", "supervise":
		items, err := m.workerList(parent.ID)
		for i := range items {
			items[i].Result = ""
			items[i].Task = clipRunes(items[i].Task, 300)
		}
		return items, err
	case "spawn":
		if !validOrchestrationText(task, 6000) {
			return nil, errors.New("请填写工作会话任务")
		}
		worker, _, err := m.spawnWorker(context.Background(), parent, modelSelection{}, "worker", "worker", "plan", task)
		return worker, err
	}
	worker, err := m.findWorker(parent.ID, id)
	if err != nil {
		return nil, errors.New("当前父会话下没有此工作会话")
	}
	switch action {
	case "status", "result":
		return worker, nil
	case "wait":
		return m.waitWorker(ctx, worker, m.orchestrationJob(worker.ID, worker.ID), true)
	case "cancel":
		return m.cancelWorker(worker)
	case "accept":
		return m.acceptWorker(worker)
	case "send":
		if worker.Mode != "plan" {
			return nil, errors.New("请在工作台中直接授权此编辑型工作会话的新任务")
		}
		if !validOrchestrationText(task, 6000) {
			return nil, errors.New("请填写工作会话任务")
		}
		next, _, err := m.continueWorker(context.Background(), worker, task)
		return next, err
	default:
		return nil, errors.New("未知的工作会话操作")
	}
}
