// sessions.go 负责编码会话的创建、重命名、归档与分支复制。
package coding

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"server/internal/model"
	"server/internal/pkg"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

// idleSession 读取会话并拒绝仍在生成或持有后台任务的会话，避免并发改写同一会话。
func (m *Module) idleSession(c *gin.Context) (model.CodingSession, bool) {
	session, ok := m.session(c)
	if ok {
		if m.orchestrationBusy(session.ID) {
			pkg.Fail(c, 409, "请先结束此会话的 Goal 或子 Agent 任务")
			return session, false
		}
		if active, exists := m.active.Load(session.ProjectID); exists && active.(runningTask).sessionID == session.ID {
			pkg.Fail(c, 409, "请等待当前会话结束生成")
			return session, false
		}
	}
	return session, ok
}

func (m *Module) updateSession(c *gin.Context) {
	var input struct {
		Title    *string `json:"title"`
		Archived *bool   `json:"archived"`
	}
	if c.ShouldBindJSON(&input) != nil || (input.Title == nil && input.Archived == nil) {
		pkg.Fail(c, 400, "请选择会话操作")
		return
	}
	m.sessionsMu.Lock()
	defer m.sessionsMu.Unlock()
	session, ok := m.idleSession(c)
	if !ok {
		return
	}
	if input.Title != nil {
		session.Title = strings.TrimSpace(*input.Title)
		if session.Title == "" || utf8.RuneCountInString(session.Title) > 80 {
			pkg.Fail(c, 400, "会话名称需为 1–80 字")
			return
		}
	}
	if input.Archived != nil {
		session.Archived = *input.Archived
	}
	if err := m.DB.Model(&session).Select("title", "archived", "updated_at").Updates(&session).Error; err != nil {
		pkg.Fail(c, 500, "更新会话失败")
		return
	}
	pkg.OK(c, session)
}

func (m *Module) forkSession(c *gin.Context) {
	m.sessionsMu.Lock()
	defer m.sessionsMu.Unlock()
	source, ok := m.idleSession(c)
	if !ok {
		return
	}
	title := []rune(source.Title)
	child := model.CodingSession{
		ID: uuid.NewString(), ProjectID: source.ProjectID,
		Title:         string(title[:min(len(title), 75)]) + "（分支）",
		ModelProvider: source.ModelProvider, ModelName: source.ModelName,
	}
	sourceFile := filepath.Join(m.StateDir, source.ID+".jsonl")
	targetFile := filepath.Join(m.StateDir, child.ID+".jsonl")
	if err := copyPiSession(sourceFile, targetFile, child.ID); err != nil {
		pkg.Fail(c, 500, "复制 Pi 会话上下文失败")
		return
	}
	err := m.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&child).Error; err != nil {
			return err
		}
		return tx.Exec(`INSERT INTO coding_messages (session_id, role, content, status, error, tools, created_at)
			SELECT ?, role, content, CASE WHEN status = 'streaming' THEN 'interrupted' ELSE status END, error, tools, created_at
			FROM coding_messages WHERE session_id = ? ORDER BY id`, child.ID, source.ID).Error
	})
	if err != nil {
		_ = os.Remove(targetFile)
		pkg.Fail(c, 500, "创建会话分支失败")
		return
	}
	pkg.OK(c, child)
}

// copyPiSession 原样复制 Pi 的 JSONL 记录，保留工具回复与上下文压缩结果，并在新文件头写入分支会话 ID。
func copyPiSession(source, target, id string) error {
	file, err := os.Open(source)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer file.Close()
	reader := bufio.NewReaderSize(file, 64<<10)
	line, err := reader.ReadSlice('\n')
	if err != nil {
		return err
	}
	var header map[string]any
	if err := json.Unmarshal(line, &header); err != nil {
		return err
	}
	if header["type"] != "session" {
		return errors.New("无效的 Pi 会话头")
	}
	header["id"] = id
	header["timestamp"] = time.Now().UTC().Format(time.RFC3339Nano)
	delete(header, "parentSession")
	temp, err := os.CreateTemp(filepath.Dir(target), ".session-fork-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	if err := json.NewEncoder(temp).Encode(header); err != nil {
		return err
	}
	if _, err := io.Copy(temp, reader); err != nil {
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), target)
}
