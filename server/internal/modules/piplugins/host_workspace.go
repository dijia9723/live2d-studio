// host_workspace.go 负责宿主侧工作区能力：把插件请求限定到用户选择的项目与会话。
package piplugins

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
)

// HostWorkspaceContext 是前端显式选择的工作区范围，插件只能访问此处指定的项目与会话。
type HostWorkspaceContext struct {
	ProjectID string `json:"project_id"`
	SessionID string `json:"session_id,omitempty"`
}

type hostWorkspaceKey struct{}

// WithHostWorkspace 在校验 UUID 后把工作区选择写入上下文；非法值不写入，后续调用会因缺少范围被拒绝。
func WithHostWorkspace(ctx context.Context, selection HostWorkspaceContext) context.Context {
	if uuid.Validate(selection.ProjectID) != nil ||
		(selection.SessionID != "" && uuid.Validate(selection.SessionID) != nil) {
		return ctx
	}
	return context.WithValue(ctx, hostWorkspaceKey{}, selection)
}

type hostWorkspaceCall func(context.Context, Installation, HostWorkspaceContext, string, json.RawMessage) (any, error)

// ConfigureHostWorkspace 注入真实工作区实现，避免插件模块直接依赖数据库或文件服务。
func (m *Module) ConfigureHostWorkspace(invoke func(context.Context, Installation, HostWorkspaceContext, string, json.RawMessage) (any, error)) {
	if m.host != nil {
		m.host.workspace = invoke
	}
}

// workspaceMethod 列出允许插件调用的只读工作区方法白名单。
func workspaceMethod(method string) bool {
	switch method {
	case "workspace.get", "projects.list", "session.getActive", "session.listMessages",
		"fs.list", "fs.readText", "fs.stat", "fs.readPreview":
		return true
	default:
		return false
	}
}

// workspacePermission 把方法映射到最小权限：文件读取与全量会话读取需要单独授权。
func workspacePermission(permissions []string, method string) bool {
	if strings.HasPrefix(method, "fs.") {
		return slices.Contains(permissions, "fs.read")
	}
	if method == "session.listMessages" {
		return slices.Contains(permissions, "session.read.all")
	}
	return workspaceMethod(method)
}

// invokeWorkspace 校验权限后把调用交给注入的实现，并设置短超时防止插件阻塞请求线程。
func (m *Module) invokeWorkspace(ctx context.Context, item Installation, method string, payload json.RawMessage) (any, error) {
	if !workspacePermission(item.Manifest.Permissions, method) || m.host.workspace == nil {
		return nil, errors.New("插件未获得此工作区能力")
	}
	selection, _ := ctx.Value(hostWorkspaceKey{}).(HostWorkspaceContext)
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return m.host.workspace(ctx, item, selection, method, payload)
}

// workspaceForWorker 处理子进程发起的工作区请求，结果必须能放进单条消息，否则返回错误给插件。
func (m *Module) workspaceForWorker(worker *hostedWorker, method string, data json.RawMessage) hostCompletionResponse {
	ctx, allowed := worker.claimWorkspace()
	if !allowed {
		return hostCompletionResponse{Error: "当前插件调用没有可用的工作区"}
	}
	item, err := m.hostInstallation(worker.installation.Manifest.ID)
	if err != nil || item.Root != worker.installation.Root {
		return hostCompletionResponse{Error: "插件状态已变更"}
	}
	result, err := m.invokeWorkspace(ctx, item, method, data)
	if err != nil {
		return hostCompletionResponse{Error: err.Error()}
	}
	payload, err := json.Marshal(result)
	if err != nil || len(payload) > workerDataLimit-1024 {
		return hostCompletionResponse{Error: "工作区结果超出插件消息大小限制"}
	}
	return hostCompletionResponse{Value: payload}
}
