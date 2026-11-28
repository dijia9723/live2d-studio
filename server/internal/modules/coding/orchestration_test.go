// orchestration_test.go 覆盖 Goal 验收判定、写入串行化以及真实的 Pi 编排流程。
package coding

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"server/internal/config"
	"server/internal/model"
	"server/internal/modules/settings"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestGoalRequiresAcceptanceEvidence(t *testing.T) {
	goal := codingGoal{Status: "running", Criteria: []goalCriterion{
		{Text: "First criterion", State: "pending"},
		{Text: "Second criterion", State: "pending"},
	}}
	result, ok := parseGoalTurn("Partial findings\n" + `GOAL_RESULT: {"next":"complete","criteria":[{"index":1,"state":"passed","evidence":"file a"}]}`)
	if !ok {
		t.Fatal("expected structured progress")
	}
	applyGoalTurn(&goal, result)
	if goal.Status != "blocked" || goal.Criteria[0].State != "passed" || goal.Criteria[1].State != "pending" {
		t.Fatalf("incomplete criteria accepted: %#v", goal)
	}
	if _, ok := parseGoalTurn(`GOAL_RESULT: {"next":"complete"}` + "\nUnrelated ending"); ok {
		t.Fatal("accepted a stray marker instead of the final report")
	}
}

func TestOrchestrationSerializesWritersWithinProject(t *testing.T) {
	m := &Module{}
	ctx := context.Background()
	_, first, err := m.claimOrchestration(ctx, "project", "editor", "first", "worker", "agent", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	defer m.finishOrchestration(first)
	if _, _, err := m.claimOrchestration(ctx, "project", "editor-two", "reject", "worker", "agent", time.Minute); err == nil {
		t.Fatal("two writers entered one project")
	}
	_, analysis, err := m.claimOrchestration(ctx, "project", "reader", "read", "subagent", "plan", time.Minute)
	if err != nil {
		t.Fatalf("read-only delegate could not coexist: %v", err)
	}
	defer m.finishOrchestration(analysis)
	if _, _, err := m.claimOrchestration(ctx, "project", "reader", "repeat", "subagent", "plan", time.Minute); err == nil {
		t.Fatal("duplicate worker entered live session")
	}
}

func TestOrchestrationUsesRealPiSessions(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("Node.js unavailable")
	}
	runtime, err := filepath.Abs("../../../pi-runtime")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(runtime, "node_modules", "@earendil-works", "pi-coding-agent")); err != nil {
		t.Skip("Pi runtime dependencies unavailable")
	}
	var goalCalls atomic.Int32
	var workerCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Model    string
			Messages json.RawMessage
			Tools    []struct {
				Function struct {
					Name       string
					Parameters json.RawMessage
				}
			}
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("missing model credential")
		}
		isDelegate := strings.Contains(string(input.Messages), "Use this custom reviewer definition")
		isForeground := strings.Contains(string(input.Messages), "Request custom delegation") && !isDelegate
		for _, tool := range input.Tools {
			if !isForeground && (tool.Function.Name == "write_file" || tool.Function.Name == "delegate_task" || tool.Function.Name == "session_task") {
				t.Errorf("background read-only turn exposed %q", tool.Function.Name)
			}
		}
		result := "Worker checked the README fixture."
		delta := map[string]any{"role": "assistant"}
		stop := "stop"
		switch {
		case strings.Contains(string(input.Messages), "Work on this user-approved coding goal"):
			switch goalCalls.Add(1) {
			case 1:
				result = "Inspected first criterion.\n" + `GOAL_RESULT: {"next":"continue","summary":"First check done","criteria":[{"index":1,"state":"passed","evidence":"README heading"}]}`
			case 2:
				result = "Second criterion verified.\n" + `GOAL_RESULT: {"next":"complete","summary":"All checks done","criteria":[{"index":2,"state":"passed","evidence":"README body"}]}`
			default:
				t.Error("unexpected Goal continuation")
			}
		case strings.Contains(string(input.Messages), "User-authorized task:"):
			workerCalls.Add(1)
			if !isDelegate && input.Model != "fixture-worker" {
				t.Errorf("worker used model %q", input.Model)
			}
			if strings.Contains(string(input.Messages), "Work on this user-approved coding goal") {
				t.Error("worker saw parent Goal context")
			}
		case isForeground:
			if strings.Contains(string(input.Messages), "Worker checked the README fixture.") {
				result = "Used independent custom review report."
			} else {
				available := false
				for _, tool := range input.Tools {
					if tool.Function.Name == "delegate_task" && strings.Contains(string(tool.Function.Parameters), "fixture-review") {
						available = true
					}
				}
				if !available {
					t.Error("custom reviewer not presented in the delegate tool schema")
				}
				delta["tool_calls"] = []any{map[string]any{
					"index": 0, "id": "delegate-fixture", "type": "function",
					"function": map[string]any{"name": "delegate_task", "arguments": `{"agent":"fixture-review","task":"Read the README fixture"}`},
				}}
				stop = "tool_calls"
			}
		default:
			t.Error("unexpected runtime request")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if stop == "stop" {
			delta["content"] = result
		}
		for _, choice := range []map[string]any{
			{"index": 0, "delta": delta, "finish_reason": nil},
			{"index": 0, "delta": map[string]string{}, "finish_reason": stop},
		} {
			chunk, _ := json.Marshal(map[string]any{
				"id": "orchestration-fixture", "object": "chat.completion.chunk", "model": "fixture", "created": 1,
				"choices": []any{choice},
			})
			fmt.Fprintf(w, "data: %s\n\n", chunk)
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	t.Setenv("STUDIO_LLM_BASE_URL", upstream.URL)
	t.Setenv("STUDIO_LLM_API_KEY", "test-key")
	m, router, project, session := orchestrationTestRouter(t, runtime)
	url := "/sessions/" + session.ID
	goal := orchestrationResponse[codingGoal](t, orchestrationRequest(t, router, "POST", url+"/goals", map[string]any{
		"title": "Verify repository", "objective": "Assess the sample application",
		"criteria": []string{"README has a heading", "README has usage instructions"},
	}))
	if goal.Status != "awaiting_approval" || goalCalls.Load() != 0 {
		t.Fatalf("Goal executed without approval: %#v", goal)
	}
	artifact := filepath.Join(project.Path, filepath.FromSlash(goal.Artifact))
	file, err := os.ReadFile(artifact)
	if err != nil || !bytes.Contains(file, []byte("README has usage instructions")) {
		t.Fatalf("missing Goal artifact: %s, %v", file, err)
	}
	approve := url + "/goals/" + goal.ID + "/approve"
	if err := os.WriteFile(artifact, []byte("modified after proposal"), 0600); err != nil {
		t.Fatal(err)
	}
	if reply := orchestrationRequest(t, router, "POST", approve, map[string]string{"mode": "plan"}); reply.Code != http.StatusConflict {
		t.Fatalf("modified artifact was approved: %d %s", reply.Code, reply.Body)
	}
	if err := os.WriteFile(artifact, file, 0600); err != nil {
		t.Fatal(err)
	}
	orchestrationResponse[codingGoal](t, orchestrationRequest(t, router, "POST", approve, map[string]string{"mode": "plan"}))
	waitOrchestration(t, m, session.ID, goal.ID)
	goal = orchestrationResponse[[]codingGoal](t, orchestrationRequest(t, router, "GET", url+"/goals", nil))[0]
	if goal.Status != "completed" || goal.Rounds != 2 || goalCalls.Load() != 2 ||
		goal.Criteria[0].State != "passed" || goal.Criteria[1].State != "passed" {
		t.Fatalf("Goal did not settle with both criteria: %#v", goal)
	}
	var transcript []model.CodingMessage
	if err := m.DB.Where("session_id = ?", session.ID).Order("id").Find(&transcript).Error; err != nil {
		t.Fatal(err)
	}
	if len(transcript) != 3 || transcript[0].Role != "user" || transcript[1].Role != "assistant" ||
		strings.Contains(transcript[1].Content, "GOAL_RESULT:") {
		t.Fatalf("internal continuation leaked to transcript: %#v", transcript)
	}
	worker := orchestrationResponse[codingWorker](t, orchestrationRequest(t, router, "POST", url+"/workers", map[string]string{
		"role": "explorer", "mode": "plan", "task": "Check the fixture README",
		"model_provider": "openai", "model_name": "fixture-worker",
	}))
	if worker.ID == session.ID || worker.Status != "running" || worker.ModelName != "fixture-worker" {
		t.Fatalf("invalid worker: %#v", worker)
	}
	waitOrchestration(t, m, worker.ID, worker.ID)
	list := orchestrationResponse[[]codingWorker](t, orchestrationRequest(t, router, "GET", url+"/workers", nil))
	if len(list) != 1 || list[0].Status != "completed" || list[0].Result != "Worker checked the README fixture." ||
		list[0].ParentID != session.ID || workerCalls.Load() != 1 {
		t.Fatalf("worker did not settle independently: %#v", list)
	}
	send := url + "/workers/" + worker.ID + "/send"
	orchestrationResponse[codingWorker](t, orchestrationRequest(t, router, "POST", send, map[string]string{"task": "Verify the result again"}))
	waitOrchestration(t, m, worker.ID, worker.ID)
	final := orchestrationResponse[[]codingWorker](t, orchestrationRequest(t, router, "GET", url+"/workers", nil))[0]
	if final.Turns != 2 || workerCalls.Load() != 2 {
		t.Fatalf("worker failed to continue: %#v", final)
	}
	activity := orchestrationResponse[struct {
		Active bool
		Worker *codingWorker
	}](t, orchestrationRequest(t, router, "GET", "/sessions/"+worker.ID+"/orchestration-status", nil))
	if activity.Active || activity.Worker == nil || activity.Worker.ParentID != session.ID || activity.Worker.Turns != 2 {
		t.Fatalf("worker session state inconsistent: %#v", activity)
	}
	if allowed, err := m.workerEditAllowed(worker.ID); err != nil || allowed {
		t.Fatalf("worker widened its permission: %v %v", allowed, err)
	}
	if w := orchestrationRequest(t, router, "POST", "/sessions/"+worker.ID+"/workers", map[string]string{
		"role": "worker", "mode": "plan", "task": "Try nesting",
	}); w.Code != http.StatusConflict {
		t.Fatalf("nested worker admitted: %d %s", w.Code, w.Body)
	}
	agent := orchestrationResponse[codingSubagent](t, orchestrationRequest(t, router, "PUT", "/subagents/fixture-review", map[string]any{
		"label": "Fixture reviewer", "instructions": "Use this custom reviewer definition", "enabled": true,
	}))
	if !agent.Enabled || agent.Builtin {
		t.Fatalf("invalid custom agent: %#v", agent)
	}
	delegation := model.CodingSession{ID: "delegate-parent", ProjectID: project.ID, Title: "Delegate fixture"}
	if err := m.DB.Create(&delegation).Error; err != nil {
		t.Fatal(err)
	}
	parentURL := "/sessions/" + delegation.ID
	w := orchestrationRequest(t, router, "POST", parentURL+"/messages", map[string]string{
		"text": "Request custom delegation", "mode": "agent",
	})
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "Used independent custom review report.") {
		t.Fatalf("model did not complete delegation: %d %s", w.Code, w.Body)
	}
	subs := orchestrationResponse[[]codingWorker](t, orchestrationRequest(t, router, "GET", parentURL+"/workers", nil))
	if len(subs) != 1 || subs[0].Role != "fixture-review" || subs[0].Status != "completed" || workerCalls.Load() != 3 {
		t.Fatalf("invalid delegated subagent: %#v", subs)
	}
	accepted := orchestrationResponse[codingWorker](t, orchestrationRequest(t, router, "POST", parentURL+"/workers/"+subs[0].ID+"/accept", nil))
	if !accepted.Accepted {
		t.Fatal("worker report acceptance did not persist")
	}
}

func orchestrationTestRouter(t *testing.T, runtime string) (*Module, *gin.Engine, model.CodingProject, model.CodingSession) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "fixture.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	handle, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	handle.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = handle.Close() })
	if err := db.AutoMigrate(&model.CodingProject{}, &model.CodingSession{}, &model.CodingMessage{}, &model.CodingEnhancements{}, &settings.Record{}); err != nil {
		t.Fatal(err)
	}
	if err := MigrateOrchestration(db); err != nil {
		t.Fatal(err)
	}
	cfg := config.Defaults()
	m := &Module{DB: db, Settings: settings.New(db, cfg), StateDir: t.TempDir(), RuntimeDir: runtime}
	t.Cleanup(m.StopOrchestration)
	project := model.CodingProject{ID: "project-fixture", Path: t.TempDir(), Name: "fixture"}
	session := model.CodingSession{ID: "parent-fixture", ProjectID: project.ID, Title: "Studio fixture"}
	if err := db.Create(&project).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&session).Error; err != nil {
		t.Fatal(err)
	}
	router := gin.New()
	m.registerOrchestration(router.Group(""))
	router.POST("/sessions/:session/messages", m.prompt)
	return m, router, project, session
}

func orchestrationRequest(t *testing.T, router http.Handler, method, url string, body any) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, url, bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	writer := httptest.NewRecorder()
	router.ServeHTTP(writer, req)
	return writer
}

func orchestrationResponse[T any](t *testing.T, writer *httptest.ResponseRecorder) T {
	t.Helper()
	var reply struct{ Data T }
	if writer.Code != http.StatusOK {
		t.Fatalf("HTTP %d: %s", writer.Code, writer.Body)
	}
	if err := json.Unmarshal(writer.Body.Bytes(), &reply); err != nil {
		t.Fatal(err)
	}
	return reply.Data
}

func waitOrchestration(t *testing.T, m *Module, session, target string) {
	t.Helper()
	if job := m.orchestrationJob(session, target); job != nil {
		select {
		case <-job.done:
		case <-time.After(40 * time.Second):
			t.Fatalf("Pi %s task did not settle", job.kind)
		}
	}
}
