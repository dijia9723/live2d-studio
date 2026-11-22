package piplugins

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"
)

type HostCompletionModel struct {
	Key       string `json:"key"`
	Name      string `json:"name"`
	IsDefault bool   `json:"isDefault"`
}

type HostCompletionRequest struct {
	System    string
	Prompt    string
	ModelKey  string
	MaxTokens int
}

type hostCompletionRequest struct {
	ID      string          `json:"id"`
	Options json.RawMessage `json:"options"`
}

type hostCompletionResponse struct {
	Value json.RawMessage `json:"value,omitempty"`
	Text  string          `json:"text,omitempty"`
	Error string          `json:"error,omitempty"`
}

func (m *Module) ConfigureHostCompletion(model func() (HostCompletionModel, error), complete func(context.Context, HostCompletionRequest) (string, error)) {
	if m.host != nil {
		m.host.model = model
		m.host.complete = complete
	}
}

func hostCompletionInput(options json.RawMessage) (HostCompletionRequest, error) {
	input := struct {
		ModelKey              string `json:"modelKey"`
		System                string `json:"system"`
		MaxTokens             int    `json:"maxTokens"`
		IncludeSessionContext bool   `json:"includeSessionContext"`
		Messages              []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}{}
	if len(options) > workerDataLimit || json.Unmarshal(options, &input) != nil ||
		input.IncludeSessionContext || len(input.Messages) == 0 || len(input.Messages) > 12 ||
		len(input.ModelKey) > 256 || len(input.System) > 6000 {
		return HostCompletionRequest{}, errors.New("模型请求无效或包含当前宿主无法提供的会话上下文")
	}
	var prompt strings.Builder
	for _, message := range input.Messages {
		if (message.Role != "user" && message.Role != "assistant") || strings.TrimSpace(message.Content) == "" {
			return HostCompletionRequest{}, errors.New("模型消息须为用户或助手的非空文本")
		}
		if len(input.Messages) > 1 {
			prompt.WriteString(message.Role)
			prompt.WriteString(": ")
		}
		prompt.WriteString(message.Content)
		if len(input.Messages) > 1 {
			prompt.WriteString("\n")
		}
		if prompt.Len() > 12_000 {
			return HostCompletionRequest{}, errors.New("模型消息超出长度限制")
		}
	}
	tokens := input.MaxTokens
	if tokens <= 0 {
		tokens = 256
	}
	return HostCompletionRequest{
		System: input.System, Prompt: prompt.String(), ModelKey: input.ModelKey, MaxTokens: min(tokens, 512),
	}, nil
}

func (m *Module) completeForWorker(worker *hostedWorker, request hostCompletionRequest) hostCompletionResponse {
	var call struct {
		Method  string `json:"workspaceMethod"`
		Payload json.RawMessage
	}
	if json.Unmarshal(request.Options, &call) == nil && call.Method != "" {
		return m.workspaceForWorker(worker, call.Method, call.Payload)
	}
	current, err := m.hostInstallation(worker.installation.Manifest.ID)
	if err != nil || current.Root != worker.installation.Root ||
		!slices.Contains(current.Manifest.Permissions, "agent.complete") || m.host.complete == nil {
		return hostCompletionResponse{Error: "插件未获得模型补全权限"}
	}
	ctx, allowed := worker.claimCompletion()
	if !allowed {
		return hostCompletionResponse{Error: "补全仅在插件命令、面板操作或编码工具的有效调用中可用"}
	}
	data, err := hostCompletionInput(request.Options)
	if err != nil {
		return hostCompletionResponse{Error: err.Error()}
	}
	if !m.host.chargeCompletion(current.Manifest.ID) {
		return hostCompletionResponse{Error: "插件每分钟的模型补全次数已达上限"}
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	text, err := m.host.complete(ctx, data)
	if err != nil {
		return hostCompletionResponse{Error: "插件的模型补全失败或已超时"}
	}
	return hostCompletionResponse{Text: clipHostText(text, 3000)}
}

func (h *pluginHost) chargeCompletion(id string) bool {
	h.completionMu.Lock()
	defer h.completionMu.Unlock()
	if h.usage == nil {
		h.usage = make(map[string][]time.Time)
	}
	now := time.Now()
	for plugin, history := range h.usage {
		active := slices.DeleteFunc(history, func(call time.Time) bool { return now.Sub(call) > time.Minute })
		if len(active) == 0 {
			delete(h.usage, plugin)
		} else {
			h.usage[plugin] = active
		}
	}
	history := h.usage[id]
	if len(history) >= 6 {
		return false
	}
	h.usage[id] = append(history, now)
	return true
}
