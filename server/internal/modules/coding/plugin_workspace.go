// plugin_workspace.go 负责响应插件对工作区、会话与只读文件的访问请求。
package coding

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"server/internal/model"
	"server/internal/modules/piplugins"

	"github.com/gin-gonic/gin"
)

// PluginWorkspaceCall 处理插件发来的工作区、会话与文件读取调用。
// 项目与会话 ID 由 Studio 分发器注入，插件参数无法选择其他项目或会话。
func (m *Module) PluginWorkspaceCall(ctx context.Context, item piplugins.Installation, selection piplugins.HostWorkspaceContext, method string, payload json.RawMessage) (any, error) {
	if selection.ProjectID == "" {
		switch method {
		case "workspace.get", "session.getActive":
			return nil, nil
		case "projects.list":
			return []any{}, nil
		}
		return nil, errors.New("请在编码工作台打开项目")
	}
	db := m.DB.WithContext(ctx)
	var project model.CodingProject
	if err := db.First(&project, "id = ?", selection.ProjectID).Error; err != nil {
		return nil, errors.New("当前工作区不可用")
	}
	switch method {
	case "workspace.get", "projects.list":
		roots := []gin.H{{"path": project.Path, "name": project.Name, "primary": true}}
		if method == "projects.list" {
			return []gin.H{{"projectId": project.ID, "primaryPath": project.Path, "name": project.Name, "roots": roots}}, nil
		}
		return gin.H{"path": project.Path, "name": project.Name, "projectId": project.ID, "roots": roots}, nil
	case "session.getActive", "session.listMessages":
		var session model.CodingSession
		if selection.SessionID == "" {
			if method == "session.getActive" {
				return nil, nil
			}
			return nil, errors.New("当前没有编码会话")
		}
		if err := db.First(&session, "id = ? AND project_id = ?", selection.SessionID, project.ID).Error; err != nil {
			return nil, errors.New("会话不属于当前工作区")
		}
		if method == "session.getActive" {
			return gin.H{"sessionId": session.ID, "projectPath": project.Path, "activeTurn": nil}, nil
		}
		var input struct {
			SessionID string `json:"sessionId"`
			Cursor    string `json:"cursor"`
			Limit     int    `json:"limit"`
		}
		if len(payload) != 0 && json.Unmarshal(payload, &input) != nil {
			return nil, errors.New("会话读取参数无效")
		}
		if input.SessionID != "" && input.SessionID != session.ID {
			return nil, errors.New("插件只能读取当前会话")
		}
		limit := 10
		if input.Limit > 0 {
			limit = min(20, input.Limit)
		}
		query := db.Where("session_id = ? AND status <> ?", session.ID, "streaming")
		if input.Cursor != "" {
			cursor, err := strconv.ParseUint(input.Cursor, 10, 64)
			if err != nil {
				return nil, errors.New("会话分页参数无效")
			}
			query = query.Where("id < ?", cursor)
		}
		var rows []model.CodingMessage
		if err := query.Order("id DESC").Limit(limit + 1).Find(&rows).Error; err != nil {
			return nil, errors.New("当前会话读取失败")
		}
		items := make([]gin.H, 0, min(limit, len(rows)))
		for _, row := range rows[:min(limit, len(rows))] {
			items = append(items, gin.H{
				"id": strconv.FormatUint(row.ID, 10), "role": row.Role,
				"content": clipRunes(row.Content, 200), "createdAt": row.CreatedAt.UnixMilli(),
			})
		}
		result := gin.H{"items": items}
		if len(rows) > limit {
			result["nextCursor"] = strconv.FormatUint(rows[limit-1].ID, 10)
		}
		return result, nil
	default:
		return pluginWorkspaceFile(ctx, project, item.Manifest, method, payload)
	}
}

// pluginWorkspaceFile 在项目根目录内执行插件的只读文件操作，并要求路径落在清单声明的范围内。
func pluginWorkspaceFile(ctx context.Context, project model.CodingProject, manifest piplugins.Manifest, method string, payload json.RawMessage) (any, error) {
	var input struct {
		Path          string `json:"path"`
		RootPath      string `json:"pathFromRoot"`
		WorkspacePath string `json:"workspacePath"`
	}
	if json.Unmarshal(payload, &input) != nil {
		if json.Unmarshal(payload, &input.Path) != nil {
			return nil, errors.New("插件文件路径无效")
		}
	}
	if input.Path == "" {
		input.Path = input.RootPath
	}
	if input.WorkspacePath != "" && filepath.Clean(input.WorkspacePath) != project.Path {
		return nil, errors.New("工作区已经切换")
	}
	local, err := localPath(input.Path, method == "fs.list")
	if err != nil || !pluginPathVisible(manifest, filepath.ToSlash(local), method == "fs.list") {
		return nil, errors.New("此路径超出插件声明的只读范围")
	}
	root, err := os.OpenRoot(project.Path)
	if err != nil {
		return nil, errors.New("项目目录已移动或不可用")
	}
	defer root.Close()
	if checkFilePath(root, local) != nil {
		return nil, errors.New("无法读取此项目文件")
	}
	if method == "fs.list" {
		entries, err := listFiles(root, filepath.ToSlash(local))
		if err != nil {
			return nil, err
		}
		output := make([]gin.H, 0, min(100, len(entries)))
		for _, item := range entries {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			name := filepath.ToSlash(filepath.Join(local, item.Name))
			if pluginPathVisible(manifest, name, item.Dir) {
				output = append(output, gin.H{"name": item.Name, "path": name, "isDirectory": item.Dir})
				if len(output) >= 80 {
					break
				}
			}
		}
		return output, nil
	}
	info, err := root.Stat(local)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("项目文件不存在或不可读取")
	}
	meta := gin.H{"size": info.Size(), "mtimeMs": info.ModTime().UnixMilli()}
	if method == "fs.stat" {
		return meta, nil
	}
	if method != "fs.readText" && method != "fs.readPreview" {
		return nil, errors.New("插件文件操作未实现")
	}
	if info.Size() > 12<<10 {
		if method == "fs.readPreview" {
			meta["kind"] = "tooLarge"
			return meta, nil
		}
		return nil, errors.New("插件文本单次读取上限为 12 KiB")
	}
	content, err := readLocalFile(root, local)
	if err != nil {
		if method == "fs.readPreview" {
			meta["kind"] = "binary"
			return meta, nil
		}
		return nil, errors.New("无法读取 UTF-8 项目文件")
	}
	if method == "fs.readText" {
		return content.Content, nil
	}
	meta["kind"], meta["content"] = "text", content.Content
	return meta, nil
}

// pluginPathVisible 用状态机匹配清单声明的通配符范围，并拒绝凭据类文件，避免插件越权读取。
func pluginPathVisible(manifest piplugins.Manifest, relative string, directory bool) bool {
	if manifest.FS.Read.Root != "workspace" {
		return false
	}
	var parts []string
	if relative != "." {
		parts = strings.Split(relative, "/")
	}
	if len(parts) > 32 {
		return false
	}
	for _, part := range parts {
		name := strings.ToLower(strings.TrimRight(part, " ."))
		ext := path.Ext(name)
		if ignoredName(name) || strings.HasPrefix(name, ".studio-pi-") ||
			strings.HasPrefix(name, "id_rsa") || strings.HasPrefix(name, "id_ed25519") ||
			name == ".ssh" || name == ".gnupg" || name == ".aws" || name == ".npmrc" ||
			ext == ".pem" || ext == ".key" || ext == ".pfx" {
			return false
		}
	}
	for i, pattern := range manifest.FS.Read.Scope {
		if i >= 64 {
			break
		}
		pattern = strings.TrimPrefix(pattern, "./")
		if pattern == "" || len(pattern) > 512 || !fs.ValidPath(pattern) || strings.ContainsAny(pattern, "\\:") {
			continue
		}
		globs := strings.Split(pattern, "/")
		if len(globs) > 32 {
			continue
		}
		var states [33][33]bool
		states[0][0] = true
		for g := 0; g < len(globs); g++ {
			for p := 0; p <= len(parts); p++ {
				if !states[g][p] {
					continue
				}
				if globs[g] == "**" {
					states[g+1][p] = true
					if p < len(parts) {
						states[g][p+1] = true
					}
				} else if p < len(parts) {
					matches, _ := path.Match(globs[g], parts[p])
					states[g+1][p+1] = states[g+1][p+1] || matches
				}
				if directory && p == len(parts) {
					return true
				}
			}
		}
		if states[len(globs)][len(parts)] {
			return true
		}
	}
	return false
}
