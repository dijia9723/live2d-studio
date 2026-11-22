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

type HostWorkspaceContext struct {
	ProjectID string `json:"project_id"`
	SessionID string `json:"session_id,omitempty"`
}

type hostWorkspaceKey struct{}

func WithHostWorkspace(ctx context.Context, selection HostWorkspaceContext) context.Context {
	if uuid.Validate(selection.ProjectID) != nil ||
		(selection.SessionID != "" && uuid.Validate(selection.SessionID) != nil) {
		return ctx
	}
	return context.WithValue(ctx, hostWorkspaceKey{}, selection)
}

type hostWorkspaceCall func(context.Context, Installation, HostWorkspaceContext, string, json.RawMessage) (any, error)

func (m *Module) ConfigureHostWorkspace(invoke func(context.Context, Installation, HostWorkspaceContext, string, json.RawMessage) (any, error)) {
	if m.host != nil {
		m.host.workspace = invoke
	}
}

func workspaceMethod(method string) bool {
	switch method {
	case "workspace.get", "projects.list", "session.getActive", "session.listMessages",
		"fs.list", "fs.readText", "fs.stat", "fs.readPreview":
		return true
	default:
		return false
	}
}

func workspacePermission(permissions []string, method string) bool {
	if strings.HasPrefix(method, "fs.") {
		return slices.Contains(permissions, "fs.read")
	}
	if method == "session.listMessages" {
		return slices.Contains(permissions, "session.read.all")
	}
	return workspaceMethod(method)
}

func (m *Module) invokeWorkspace(ctx context.Context, item Installation, method string, payload json.RawMessage) (any, error) {
	if !workspacePermission(item.Manifest.Permissions, method) || m.host.workspace == nil {
		return nil, errors.New("插件未获得此工作区能力")
	}
	selection, _ := ctx.Value(hostWorkspaceKey{}).(HostWorkspaceContext)
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return m.host.workspace(ctx, item, selection, method, payload)
}

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
