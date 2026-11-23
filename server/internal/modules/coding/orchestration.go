// orchestration.go 负责 Goal 与子 Agent 任务的并发名额、生命周期与后台对话执行。
package coding

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"server/internal/config"
	"server/internal/model"
	"server/internal/pkg"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

const (
	maxOrchestrationJobs = 4
	maxProjectJobs       = 3
	maxBackgroundAnswer  = 512 << 10
)

type orchestrationJob struct {
	session, project, target string
	kind, mode               string
	cancel                   context.CancelFunc
	done                     chan struct{}
}

type delegationContextKey struct{}

func delegatedContext(ctx context.Context) bool {
	return ctx.Value(delegationContextKey{}) == true
}

func delegated(ctx context.Context) context.Context {
	return context.WithValue(ctx, delegationContextKey{}, true)
}

// MigrateOrchestration 迁移 Goal、工作会话与子 Agent 表，并把上次退出时仍标记为运行中的任务改为可继续的中断状态。
func MigrateOrchestration(db *gorm.DB) error {
	if err := db.AutoMigrate(&codingGoal{}, &codingWorker{}, &codingSubagent{}); err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		for _, row := range []any{&codingGoal{}, &codingWorker{}} {
			if err := tx.Model(row).Where("status = ?", "running").
				Updates(map[string]any{"status": "interrupted", "error": "应用退出时任务仍在运行，可手动继续"}).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func (m *Module) registerOrchestration(group *gin.RouterGroup) {
	group.GET("/sessions/:session/goals", m.listGoals)
	group.POST("/sessions/:session/goals", m.createGoal)
	group.POST("/sessions/:session/goals/:goal/:action", m.goalAction)
	group.GET("/sessions/:session/workers", m.listWorkers)
	group.POST("/sessions/:session/workers", m.createWorker)
	group.POST("/sessions/:session/workers/:worker/:action", m.workerAction)
	group.GET("/sessions/:session/orchestration-status", m.sessionOrchestrationStatus)
	group.GET("/subagents", m.listSubagents)
	group.PUT("/subagents/:name", m.putSubagent)
	group.DELETE("/subagents/:name", m.resetSubagent)
}

func (m *Module) orchestrationBusy(session string) bool {
	_, exists := m.orchestrationJobs.Load(session)
	return exists
}

// claimOrchestration 在 sessionsMu 保护下申请一个编排任务名额；它与前台提问共用同一把锁，
// 只读任务可以并行，而所有可写任务必须先占用项目的写入槽。
func (m *Module) claimOrchestration(ctx context.Context, project, session, target, kind, mode string, timeout time.Duration) (context.Context, *orchestrationJob, error) {
	if m.orchestrationBusy(session) {
		return nil, nil, errors.New("此会话已有任务正在运行")
	}
	total, local := 0, 0
	m.orchestrationJobs.Range(func(_, value any) bool {
		total++
		if value.(*orchestrationJob).project == project {
			local++
		}
		return total < maxOrchestrationJobs
	})
	if total >= maxOrchestrationJobs || local >= maxProjectJobs {
		return nil, nil, errors.New("并行任务已达上限，请等待已有任务完成")
	}
	if task, exists := m.active.Load(project); exists && (mode == "agent" || task.(runningTask).sessionID == session) {
		return nil, nil, errors.New("此会话正在生成，或项目正由另一个任务编辑")
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	job := &orchestrationJob{
		session: session, project: project, target: target, kind: kind, mode: mode,
		cancel: cancel, done: make(chan struct{}),
	}
	if mode == "agent" {
		if _, exists := m.active.LoadOrStore(project, runningTask{session, cancel}); exists {
			cancel()
			return nil, nil, errors.New("项目正由另一个任务编辑")
		}
	}
	m.orchestrationJobs.Store(session, job)
	return runCtx, job, nil
}

func (m *Module) finishOrchestration(job *orchestrationJob) {
	job.cancel()
	if job.mode == "agent" {
		m.active.Delete(job.project)
	}
	m.orchestrationJobs.CompareAndDelete(job.session, job)
	close(job.done)
}

func (m *Module) orchestrationJob(session, target string) *orchestrationJob {
	if value, ok := m.orchestrationJobs.Load(session); ok {
		job := value.(*orchestrationJob)
		if job.target == target {
			return job
		}
	}
	return nil
}

// StopOrchestration 取消所有后台编排任务，并最多等待 4 秒让其收尾，避免退出时挂起。
func (m *Module) StopOrchestration() {
	var running []*orchestrationJob
	m.sessionsMu.Lock()
	m.orchestrationJobs.Range(func(_, value any) bool {
		job := value.(*orchestrationJob)
		running = append(running, job)
		job.cancel()
		return true
	})
	m.sessionsMu.Unlock()
	timer := time.NewTimer(4 * time.Second)
	defer timer.Stop()
	for _, job := range running {
		select {
		case <-job.done:
		case <-timer.C:
			return
		}
	}
}

func (m *Module) orchestrationConfig(selection modelSelection) (config.LLM, error) {
	if _, _, err := m.runtimePaths(); err != nil {
		return config.LLM{}, err
	}
	llm, err := m.resolveSelectedLLM(selection)
	if err != nil {
		return config.LLM{}, err
	}
	if err := codingLLMReady(llm); err != nil {
		return config.LLM{}, err
	}
	return llm, nil
}

// backgroundTurn 为每个会话使用独立且持久化的 Pi 历史。Goal 轮次只在 Studio 的对话记录中
// 保留用户真实请求和助手回复，内部的续跑提示只传给 Worker 运行时。
func (m *Module) backgroundTurn(ctx context.Context, root *os.Root, cfg config.LLM, project, session, mode, prompt, visibleUser string) (model.CodingMessage, error) {
	if visibleUser != "" {
		if err := m.DB.Create(&model.CodingMessage{SessionID: session, Role: "user", Status: "complete", Content: visibleUser}).Error; err != nil {
			return model.CodingMessage{}, err
		}
	}
	var answer strings.Builder
	message := model.CodingMessage{SessionID: session, Role: "assistant", Status: "complete"}
	err := m.runPi(delegated(ctx), root, cfg, project, session, mode, prompt, model.CodingEnhancements{}, func(event runtimeEvent) error {
		switch event.Type {
		case "delta":
			if answer.Len()+len(event.Text) > maxBackgroundAnswer {
				return errors.New("回复超出长度限制")
			}
			answer.WriteString(event.Text)
		case "tool":
			message.Tools = append(message.Tools, model.CodingToolRun{Name: event.Name, Path: event.Path})
		}
		return nil
	})
	message.Content = answer.String()
	if errors.Is(ctx.Err(), context.Canceled) {
		message.Status = "interrupted"
	} else if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		message.Status, message.Error = "failed", "任务已超时"
	} else if err != nil {
		message.Status, message.Error = "failed", clipRunes(err.Error(), 500)
	}
	if saveErr := m.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&message).Error; err != nil {
			return err
		}
		return tx.Model(&model.CodingSession{}).Where("id = ?", session).Update("updated_at", time.Now()).Error
	}); saveErr != nil {
		return message, fmt.Errorf("保存任务结果失败: %w", saveErr)
	}
	return message, err
}

func orchestrationSession(c *gin.Context, m *Module) (model.CodingSession, bool) {
	session, ok := m.session(c)
	if ok && session.Archived {
		pkg.Fail(c, 409, "请先恢复归档会话")
		return session, false
	}
	return session, ok
}
