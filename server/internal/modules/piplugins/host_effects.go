// host_effects.go 负责校验并路由插件产生的界面事件、存储写入与插件间总线消息。
package piplugins

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"
)

// hostTopicMatch 支持精确段匹配、单段通配 * 与后缀通配 **，用于限定总线话题范围。
func hostTopicMatch(pattern, topic string) bool {
	if prefix, ok := strings.CutSuffix(pattern, ".**"); ok {
		return topic == prefix || strings.HasPrefix(topic, prefix+".")
	}
	parts, values := strings.Split(pattern, "."), strings.Split(topic, ".")
	if len(parts) != len(values) {
		return false
	}
	for i, part := range parts {
		if part != "*" && part != values[i] {
			return false
		}
	}
	return true
}

// topicIn 在匹配前先校验话题标识，避免通配模式被异常字符绕过。
func topicIn(patterns []string, topic string) bool {
	return hostMemberID.MatchString(topic) && slices.ContainsFunc(patterns, func(pattern string) bool {
		return hostTopicMatch(pattern, topic)
	})
}

// applyHostEffects 逐条校验事件类型与权限后再落地，限制事件数量与转发深度，
// 防止插件通过事件链形成无限递归或刷屏。
func (m *Module) applyHostEffects(ctx context.Context, item Installation, events []hostEvent, depth int) []hostEvent {
	out := []hostEvent{}
	if len(events) == 0 || m.host == nil || depth >= 4 {
		return out
	}
	current, err := m.hostInstallation(item.Manifest.ID)
	if err != nil || current.Root != item.Root {
		return out
	}
	spec := item.Manifest.hostSpec()
	for _, event := range events {
		if len(out) >= 24 || ctx.Err() != nil {
			break
		}
		switch event.Type {
		case "toast":
			if slices.Contains(spec.Permissions, "notify") || slices.Contains(spec.Permissions, "ui.panel") {
				out = append(out, hostEvent{Type: "toast", Text: clipHostText(event.Text, 400)})
			}
		case "panel":
			if slices.ContainsFunc(spec.Views, func(view hostView) bool { return view.ID == event.ID }) {
				out = append(out, hostEvent{Type: "panel", ID: event.ID, Title: clipHostText(event.Title, 160)})
			}
		case "settings":
			var settings map[string]json.RawMessage
			if len(event.Data) <= workerDataLimit && json.Unmarshal(event.Data, &settings) == nil {
				_, _ = m.storeHostSettings(item, settings)
			}
		case "storage":
			var storage map[string]json.RawMessage
			if len(event.Data) <= workerDataLimit && json.Unmarshal(event.Data, &storage) == nil {
				m.host.dataMu.Lock()
				data := m.readHostData(item)
				data.Storage = storage
				_ = m.writeHostData(item.Manifest.ID, data)
				m.host.dataMu.Unlock()
			}
		case "bus":
			if len(event.Data) <= workerDataLimit && topicIn(spec.Bus.Publish, event.Topic) {
				out = append(out, m.routeHostMessage(ctx, item.Manifest.ID, event, depth)...)
			}
		}
	}
	return out[:min(len(out), 24)]
}

// routeHostMessage 把总线消息投递给已订阅的其他插件，并设置总超时避免互相等待。
func (m *Module) routeHostMessage(ctx context.Context, from string, event hostEvent, depth int) []hostEvent {
	ctx, cancel := context.WithTimeout(ctx, 1800*time.Millisecond)
	defer cancel()
	out := []hostEvent{}
	for _, receiver := range m.hostInstallations() {
		if ctx.Err() != nil || len(out) >= 24 {
			break
		}
		if receiver.Manifest.ID == from || !topicIn(receiver.Manifest.hostSpec().Bus.Subscribe, event.Topic) {
			continue
		}
		response, err := m.executeHost(ctx, receiver, hostRequest{
			Operation: "bus", ID: event.Topic, From: from, Payload: event.Data,
		}, depth+1)
		if err == nil {
			out = append(out, response.Events...)
		}
	}
	return out
}

// HostAgentTool 是已获执行授权的插件在清单中声明的编码工具。
type HostAgentTool struct {
	PluginID    string          `json:"plugin_id"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Risk        string          `json:"risk,omitempty"`
	Schema      json.RawMessage `json:"schema"`
}

// HostAgentTools 汇总当前可执行插件声明的工具，供编码代理注册。
func (m *Module) HostAgentTools(ctx context.Context) []HostAgentTool {
	list := make([]HostAgentTool, 0)
	for _, installed := range m.hostInstallations() {
		if ctx.Err() != nil || len(list) >= 32 {
			break
		}
		for _, item := range installed.Manifest.hostSpec().Tools {
			list = append(list, HostAgentTool{
				PluginID: installed.Manifest.ID, Name: item.Name, Description: clipHostText(item.Description, 700), Risk: item.Risk, Schema: item.Schema,
			})
		}
	}
	return list[:min(len(list), 32)]
}

// CallHostAgentTool 调用指定插件的编码工具；只允许清单中声明过的工具名。
func (m *Module) CallHostAgentTool(ctx context.Context, pluginID, name string, args json.RawMessage) (json.RawMessage, error) {
	item, err := m.hostInstallation(pluginID)
	if err != nil {
		return nil, err
	}
	if !slices.ContainsFunc(item.Manifest.hostSpec().Tools, func(tool hostTool) bool { return tool.Name == name }) {
		return nil, errors.New("插件没有声明此编码工具")
	}
	result, err := m.executeHost(ctx, item, hostRequest{Operation: "tool", ID: name, Payload: args}, 0)
	if err != nil {
		return nil, err
	}
	return result.Result, nil
}
