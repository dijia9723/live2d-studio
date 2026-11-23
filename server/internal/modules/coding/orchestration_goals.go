// orchestration_goals.go 负责 Goal 的创建、审批、续跑与验收条件推进。
package coding

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"server/internal/config"
	"server/internal/model"
	"server/internal/pkg"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

const goalRoundsPerRun = 6

type goalCriterion struct {
	Text     string `json:"text"`
	State    string `json:"state"`
	Evidence string `json:"evidence,omitempty"`
}

type codingGoal struct {
	ID           string          `gorm:"primaryKey" json:"id"`
	SessionID    string          `gorm:"index" json:"session_id"`
	ProjectID    string          `json:"project_id"`
	Title        string          `json:"title"`
	Objective    string          `json:"objective"`
	Criteria     []goalCriterion `gorm:"serializer:json;type:text" json:"criteria"`
	Status       string          `json:"status"`
	Mode         string          `json:"mode"`
	Rounds       int             `json:"rounds"`
	Started      bool            `json:"-"`
	Summary      string          `json:"summary,omitempty"`
	Error        string          `json:"error,omitempty"`
	Artifact     string          `json:"artifact"`
	ArtifactHash string          `json:"artifact_hash"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
}

func (m *Module) listGoals(c *gin.Context) {
	session, ok := m.session(c)
	if !ok {
		return
	}
	records := []codingGoal{}
	if err := m.DB.Where("session_id = ?", session.ID).Order("created_at desc").Limit(20).Find(&records).Error; err != nil {
		pkg.Fail(c, 500, "读取目标失败")
		return
	}
	pkg.OK(c, records)
}

func validOrchestrationText(text string, max int) bool {
	return strings.TrimSpace(text) != "" && !strings.ContainsRune(text, 0) && utf8.RuneCountInString(text) <= max
}

// createGoal 先写出目标文档并记录哈希，再把提案置为待审批；新提案会作废同一会话中尚未审批的旧提案。
func (m *Module) createGoal(c *gin.Context) {
	var input struct {
		Title     string   `json:"title"`
		Objective string   `json:"objective"`
		Criteria  []string `json:"criteria"`
	}
	if c.ShouldBindJSON(&input) != nil || !validOrchestrationText(input.Title, 100) ||
		!validOrchestrationText(input.Objective, 12000) || len(input.Criteria) == 0 || len(input.Criteria) > 12 {
		pkg.Fail(c, 400, "请填写目标名称、目标说明和 1–12 条验收条件")
		return
	}
	title := strings.Join(strings.Fields(input.Title), " ")
	goal := codingGoal{ID: uuid.NewString(), Title: title, Objective: strings.TrimSpace(input.Objective),
		Status: "awaiting_approval", Mode: "plan"}
	seen := make(map[string]bool)
	for _, text := range input.Criteria {
		text = strings.Join(strings.Fields(text), " ")
		if !validOrchestrationText(text, 500) || seen[text] {
			pkg.Fail(c, 400, "验收条件须各不相同，每条 1–500 字")
			return
		}
		seen[text] = true
		goal.Criteria = append(goal.Criteria, goalCriterion{Text: text, State: "pending"})
	}
	m.sessionsMu.Lock()
	defer m.sessionsMu.Unlock()
	session, ok := orchestrationSession(c, m)
	if !ok {
		return
	}
	if isWorkerSession(m.DB, session.ID) {
		pkg.Fail(c, 409, "请在父会话中创建目标")
		return
	}
	if m.orchestrationBusy(session.ID) {
		pkg.Fail(c, 409, "请先暂停当前目标")
		return
	}
	goal.ProjectID, goal.SessionID = session.ProjectID, session.ID
	root := m.openProject(c, session.ProjectID)
	if root == nil {
		return
	}
	defer root.Close()
	content := goalMarkdown(goal)
	hash := sha256.Sum256([]byte(content))
	goal.Artifact, goal.ArtifactHash = ".pi/goal/"+goal.ID+".md", fmt.Sprintf("%x", hash)
	m.filesMu.Lock()
	artifactErr := writeGoalArtifact(root, goal.Artifact, content)
	m.filesMu.Unlock()
	if artifactErr != nil {
		pkg.Fail(c, 409, "无法在项目的 .pi/goal 目录保存目标")
		return
	}
	err := m.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&codingGoal{}).Where("session_id = ? AND status = ?", session.ID, "awaiting_approval").Update("status", "superseded").Error; err != nil {
			return err
		}
		return tx.Create(&goal).Error
	})
	if err != nil {
		_ = root.Remove(filepath.FromSlash(goal.Artifact))
		pkg.Fail(c, 500, "保存目标失败")
		return
	}
	pkg.OK(c, goal)
}

// writeGoalArtifact 以排他方式创建目标文档，并复用项目路径校验，保证文件不会被静默覆盖。
func writeGoalArtifact(root *os.Root, path, text string) error {
	path = filepath.FromSlash(path)
	if err := checkFilePath(root, path); err != nil {
		return err
	}
	if err := root.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	file, err := root.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return err
	}
	_, writeErr := io.WriteString(file, text)
	if err := errors.Join(writeErr, file.Close()); err != nil {
		_ = root.Remove(path)
		return err
	}
	return nil
}

func goalMarkdown(goal codingGoal) string {
	var text strings.Builder
	fmt.Fprintf(&text, "# %s\n\n%s\n\n## 验收条件\n", goal.Title, goal.Objective)
	for i, criterion := range goal.Criteria {
		fmt.Fprintf(&text, "%d. %s\n", i+1, criterion.Text)
	}
	return text.String()
}

func (m *Module) goalAction(c *gin.Context) {
	var input struct {
		Mode string `json:"mode"`
		Note string `json:"note"`
	}
	action := c.Param("action")
	if action == "approve" || action == "resume" {
		if c.ShouldBindJSON(&input) != nil || (input.Mode != "agent" && input.Mode != "plan" && input.Mode != "") ||
			utf8.RuneCountInString(input.Note) > 2000 {
			pkg.Fail(c, 400, "目标操作参数无效")
			return
		}
	}
	m.sessionsMu.Lock()
	defer m.sessionsMu.Unlock()
	session, ok := orchestrationSession(c, m)
	if !ok {
		return
	}
	var goal codingGoal
	if err := m.DB.First(&goal, "id = ? AND session_id = ?", c.Param("goal"), session.ID).Error; err != nil {
		resourceError(c, err, "目标")
		return
	}
	previous := goal.Status
	switch action {
	case "approve", "resume":
		m.startGoal(c, &goal, action, input.Mode, strings.TrimSpace(input.Note), sessionSelection(session))
		return
	case "reject":
		if goal.Status != "awaiting_approval" {
			pkg.Fail(c, 409, "此目标不在审批中")
			return
		}
		goal.Status = "rejected"
	case "pause":
		if goal.Status != "running" {
			pkg.Fail(c, 409, "此目标未在运行")
			return
		}
		goal.Status = "paused"
	case "cancel":
		if !goalCanResume(goal.Status) && goal.Status != "running" && goal.Status != "awaiting_approval" {
			pkg.Fail(c, 409, "此目标已结束")
			return
		}
		goal.Status = "cancelled"
	default:
		pkg.Fail(c, 400, "未知的目标操作")
		return
	}
	goal.Error = ""
	update := m.DB.Model(&goal).Where("status = ?", previous).Select("status", "error", "updated_at").Updates(&goal)
	if update.Error != nil {
		pkg.Fail(c, 500, "更新目标失败")
		return
	}
	if update.RowsAffected == 0 {
		pkg.Fail(c, 409, "目标状态已变更，请刷新后再操作")
		return
	}
	if job := m.orchestrationJob(session.ID, goal.ID); job != nil {
		job.cancel()
	}
	pkg.OK(c, goal)
}

func goalCanResume(status string) bool {
	switch status {
	case "paused", "blocked", "failed", "interrupted":
		return true
	default:
		return false
	}
}

func (m *Module) startGoal(c *gin.Context, goal *codingGoal, action, mode, note string, selection modelSelection) {
	if (action == "approve" && goal.Status != "awaiting_approval") || (action == "resume" && !goalCanResume(goal.Status)) {
		pkg.Fail(c, 409, "目标当前状态不能执行此操作")
		return
	}
	if mode == "" {
		mode = goal.Mode
	}
	if action == "resume" && mode != goal.Mode {
		pkg.Fail(c, 409, "目标续跑沿用已审批的运行权限")
		return
	}
	cfg, err := m.orchestrationConfig(selection)
	if err != nil {
		pkg.Fail(c, 503, err.Error())
		return
	}
	root := m.openProject(c, goal.ProjectID)
	if root == nil {
		return
	}
	// 执行前复核目标文件哈希，确保审批的就是用户看到的那份内容，防止目录被替换或改写。
	if artifact, err := readFile(root, goal.Artifact); err != nil || artifact.Revision != goal.ArtifactHash {
		_ = root.Close()
		pkg.Fail(c, 409, "目标文件已移动或变更，请创建新提案")
		return
	}
	ctx, job, err := m.claimOrchestration(context.Background(), goal.ProjectID, goal.SessionID, goal.ID, "goal", mode, 10*time.Minute)
	if err != nil {
		_ = root.Close()
		pkg.Fail(c, 409, err.Error())
		return
	}
	goal.Status, goal.Mode, goal.Error = "running", mode, ""
	if err := m.DB.Model(goal).Select("status", "mode", "error", "updated_at").Updates(goal).Error; err != nil {
		m.finishOrchestration(job)
		_ = root.Close()
		pkg.Fail(c, 500, "启动目标失败")
		return
	}
	record := *goal
	go m.runGoal(ctx, job, root, cfg, record, note)
	pkg.OK(c, record)
}

type goalTurnResult struct {
	Next     string `json:"next"`
	Summary  string `json:"summary"`
	Criteria []struct {
		Index    int    `json:"index"`
		State    string `json:"state"`
		Evidence string `json:"evidence"`
	} `json:"criteria"`
}

// parseGoalTurn 从回复最后一行解析 GOAL_RESULT 标记；只接受最后一行，避免正文中的示例被误当作进度。
func parseGoalTurn(text string) (goalTurnResult, bool) {
	var result goalTurnResult
	lines := strings.TrimSpace(text)
	last := strings.TrimSpace(lines[strings.LastIndexByte(lines, '\n')+1:])
	raw, ok := strings.CutPrefix(last, "GOAL_RESULT:")
	if !ok || len(raw) > 24000 || json.Unmarshal([]byte(raw), &result) != nil ||
		(result.Next != "continue" && result.Next != "complete" && result.Next != "blocked") {
		return goalTurnResult{}, false
	}
	return result, true
}

func goalPrompt(goal codingGoal, note string) string {
	progress, _ := json.Marshal(goal.Criteria)
	return fmt.Sprintf(`Work on this user-approved coding goal. Stay within the tools and permissions this session grants.
The goal document below is the user's request. Evaluate each acceptance criterion using concrete project evidence.
Review the persisted progress and continue from the latest state.
Finish the reply with one plain single-line result, outside any code fence:
GOAL_RESULT: {"next":"continue|complete|blocked","summary":"short progress","criteria":[{"index":1,"state":"passed|pending|failed","evidence":"specific file, output, or other observed evidence"}]}
Use numeric 1-based indexes. Report passed only when observed evidence warrants it. Choose continue only when a distinct next step is achievable with granted tools.
Write normal findings above this line.

%s
Progress (JSON): %s
Latest user direction: %s`, goalMarkdown(goal), progress, note)
}

// applyGoalTurn 只采纳带具体证据的通过状态；缺少证据时不允许把目标标记为完成。
func applyGoalTurn(goal *codingGoal, result goalTurnResult) {
	for _, item := range result.Criteria {
		if item.Index < 1 || item.Index > len(goal.Criteria) || (item.State != "passed" && item.State != "failed" && item.State != "pending") {
			continue
		}
		evidence := clipRunes(strings.TrimSpace(item.Evidence), 1500)
		if item.State == "passed" && evidence == "" {
			continue
		}
		criterion := &goal.Criteria[item.Index-1]
		criterion.State, criterion.Evidence = item.State, evidence
	}
	goal.Summary = clipRunes(strings.TrimSpace(result.Summary), 3000)
	if result.Next == "complete" {
		for _, criterion := range goal.Criteria {
			if criterion.State != "passed" {
				goal.Status, goal.Error = "blocked", "仍有验收条件缺少通过证据"
				return
			}
		}
		goal.Status = "completed"
	} else if result.Next == "blocked" {
		goal.Status = "blocked"
	}
}

func (m *Module) runGoal(ctx context.Context, job *orchestrationJob, root *os.Root, cfg config.LLM, goal codingGoal, note string) {
	defer m.finishOrchestration(job)
	defer root.Close()
	defer func() {
		m.DB.Model(&goal).Where("status = ?", "running").
			Updates(map[string]any{"status": "failed", "error": "目标执行未能保存，可继续"})
	}()
	for i := 0; i < goalRoundsPerRun; i++ {
		if ctx.Err() != nil {
			m.DB.Model(&goal).Where("status = ?", "running").
				Updates(map[string]any{"status": "interrupted", "error": "执行已中断，可继续"})
			return
		}
		var visibleInput string
		if !goal.Started {
			input := model.CodingMessage{SessionID: goal.SessionID, Role: "user", Status: "complete", Content: goalMarkdown(goal)}
			if err := m.DB.Transaction(func(tx *gorm.DB) error {
				updated := tx.Model(&goal).Where("status = ?", "running").Update("started", true)
				if updated.Error != nil {
					return updated.Error
				}
				if updated.RowsAffected == 0 {
					return errors.New("目标当前不在运行")
				}
				return tx.Create(&input).Error
			}); err != nil {
				return
			}
			goal.Started = true
		} else if note != "" {
			visibleInput = note
		}
		message, err := m.backgroundTurn(ctx, root, cfg, goal.ProjectID, goal.SessionID, job.mode, goalPrompt(goal, note), visibleInput)
		note = ""
		goal.Rounds++
		switch {
		case ctx.Err() != nil:
			goal.Status, goal.Error = "interrupted", "执行已中断，可继续"
		case err != nil || message.Status != "complete":
			goal.Status, goal.Error = "failed", message.Error
			if goal.Error == "" {
				goal.Error = "无法保存目标执行结果"
			}
		default:
			result, ok := parseGoalTurn(message.Content)
			if ok {
				applyGoalTurn(&goal, result)
				pos := strings.LastIndex(strings.TrimSpace(message.Content), "\n")
				visibleReport := goal.Summary
				if pos >= 0 {
					visibleReport = strings.TrimSpace(strings.TrimSpace(message.Content)[:pos])
				}
				m.DB.Model(&message).Update("content", visibleReport)
			} else {
				goal.Status, goal.Error = "blocked", "模型未返回可验证的验收状态"
			}
		}
		if goal.Status == "running" && i == goalRoundsPerRun-1 {
			goal.Status, goal.Error = "paused", "本次已执行 6 轮，可继续下一轮"
		}
		updated := m.DB.Model(&goal).Where("status = ?", "running").
			Select("criteria", "status", "rounds", "summary", "error", "updated_at").Updates(&goal)
		if updated.Error != nil || updated.RowsAffected == 0 || goal.Status != "running" {
			return
		}
	}
}
