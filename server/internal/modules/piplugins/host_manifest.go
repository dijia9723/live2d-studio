package piplugins

import (
	"encoding/json"
	"regexp"
	"slices"
	"strings"
)

var hostMemberID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$`)

type hostLabel string

func (s *hostLabel) UnmarshalJSON(data []byte) error {
	var plain string
	if json.Unmarshal(data, &plain) == nil {
		*s = hostLabel(plain)
		return nil
	}
	var translations map[string]string
	if err := json.Unmarshal(data, &translations); err != nil {
		return err
	}
	*s = hostLabel(firstText(translations["zh-CN"], translations["en"]))
	return nil
}

type hostCommand struct {
	ID    string    `json:"id"`
	Title hostLabel `json:"title"`
}

type hostView struct {
	ID    string    `json:"id"`
	Title hostLabel `json:"title"`
	Kind  string    `json:"kind"`
	Entry string    `json:"entry,omitempty"`
}

type hostTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Risk        string          `json:"risk,omitempty"`
	Schema      json.RawMessage `json:"schema"`
}

type hostSetting struct {
	Key         string          `json:"key"`
	Type        string          `json:"type"`
	Title       hostLabel       `json:"title"`
	Description hostLabel       `json:"description,omitempty"`
	Default     json.RawMessage `json:"default,omitempty"`
	Options     json.RawMessage `json:"options,omitempty"`
}

type hostService struct {
	ID string `json:"id"`
}

type hostBus struct {
	Publish   []string `json:"publish"`
	Subscribe []string `json:"subscribe"`
}

type hostSpec struct {
	ID          string        `json:"id"`
	Name        string        `json:"name"`
	Permissions []string      `json:"permissions"`
	Commands    []hostCommand `json:"commands"`
	Views       []hostView    `json:"views"`
	Settings    []hostSetting `json:"settings"`
	Tools       []hostTool    `json:"tools"`
	Services    []hostService `json:"services"`
	Bus         hostBus       `json:"bus"`
}

func (m Manifest) hostSpec() hostSpec {
	name, _, _ := localize(m.Name, m.Description, m.SafetyNotes, m.I18n)
	spec := hostSpec{ID: m.ID, Name: name, Permissions: m.Permissions,
		Commands: []hostCommand{}, Views: []hostView{}, Settings: []hostSetting{}, Tools: []hostTool{}, Services: []hostService{},
	}
	var declarations map[string]json.RawMessage
	_ = json.Unmarshal(m.Contributes, &declarations)
	// Decode categories separately so an unfamiliar contribution does not hide compatible ones.
	if err := json.Unmarshal(declarations["commands"], &spec.Commands); err != nil {
		spec.Commands = nil
	}
	spec.Commands = slices.DeleteFunc(spec.Commands, func(command hostCommand) bool {
		return !hostMemberID.MatchString(command.ID)
	})
	if slices.Contains(m.Permissions, "ui.view") {
		if json.Unmarshal(declarations["views"], &spec.Views) != nil {
			spec.Views = nil
		}
		spec.Views = slices.DeleteFunc(spec.Views, func(view hostView) bool {
			_, err := packagePath(view.Entry)
			return !hostMemberID.MatchString(view.ID) || view.ID == "panel" || err != nil || !slices.Contains([]string{".html", ".htm"}, extension(view.Entry))
		})
		for i := range spec.Views {
			spec.Views[i].Kind = "view"
		}
	}
	if m.UI.Panel != "" && slices.Contains(m.Permissions, "ui.panel") &&
		slices.Contains([]string{".html", ".htm"}, extension(m.UI.Panel)) {
		spec.Views = append(spec.Views, hostView{ID: "panel", Title: hostLabel(name), Kind: "panel", Entry: m.UI.Panel})
	}
	if json.Unmarshal(declarations["settings"], &spec.Settings) != nil {
		spec.Settings = nil
	}
	spec.Settings = slices.DeleteFunc(spec.Settings, func(setting hostSetting) bool {
		return !hostMemberID.MatchString(setting.Key) || !slices.Contains(
			[]string{"string", "number", "boolean", "enum", "select", "integer", "textarea", "password"}, setting.Type)
	})
	if slices.Contains(m.Permissions, "agent.tool.register") {
		if json.Unmarshal(declarations["agentTools"], &spec.Tools) != nil {
			spec.Tools = nil
		}
		spec.Tools = slices.DeleteFunc(spec.Tools, func(tool hostTool) bool {
			return !hostMemberID.MatchString(tool.Name) || strings.TrimSpace(tool.Description) == "" || len(tool.Schema) == 0 || len(tool.Schema) > 48<<10
		})
	}
	if slices.Contains(m.Permissions, "background.service") {
		if json.Unmarshal(declarations["services"], &spec.Services) != nil {
			spec.Services = nil
		}
		spec.Services = slices.DeleteFunc(spec.Services, func(service hostService) bool { return !hostMemberID.MatchString(service.ID) })
	}
	if json.Unmarshal(declarations["bus"], &spec.Bus) != nil {
		spec.Bus = hostBus{}
	}
	if !slices.Contains(m.Permissions, "bus.publish") {
		spec.Bus.Publish = nil
	}
	if !slices.Contains(m.Permissions, "bus.subscribe") {
		spec.Bus.Subscribe = nil
	}
	spec.Commands = spec.Commands[:min(len(spec.Commands), 64)]
	spec.Views = spec.Views[:min(len(spec.Views), 32)]
	spec.Settings = spec.Settings[:min(len(spec.Settings), 96)]
	spec.Tools = spec.Tools[:min(len(spec.Tools), 32)]
	spec.Services = spec.Services[:min(len(spec.Services), 16)]
	spec.Bus.Publish = spec.Bus.Publish[:min(len(spec.Bus.Publish), 64)]
	spec.Bus.Subscribe = spec.Bus.Subscribe[:min(len(spec.Bus.Subscribe), 64)]
	return spec
}

func (m Manifest) hostCapabilities() []string {
	spec := m.hostSpec()
	var capable []string
	entry := m.Main != "" && slices.Contains([]string{".js", ".cjs"}, extension(m.Main))
	if entry && len(spec.Commands) != 0 {
		capable = append(capable, "commands")
	}
	for _, view := range spec.Views {
		if !slices.Contains(capable, view.Kind) {
			capable = append(capable, view.Kind)
		}
	}
	for i := range capable {
		if capable[i] == "view" {
			capable[i] = "views"
		}
	}
	if len(spec.Settings) != 0 {
		capable = append(capable, "settings")
	}
	if entry && len(spec.Tools) != 0 {
		capable = append(capable, "agentTools")
	}
	if entry && len(spec.Services) != 0 {
		capable = append(capable, "services")
	}
	if entry && len(spec.Bus.Publish)+len(spec.Bus.Subscribe) != 0 {
		capable = append(capable, "bus")
	}
	return capable
}
