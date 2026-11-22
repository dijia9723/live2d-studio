package coding

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPluginSkillDocument(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "release.md"), []byte("---\r\nname: Release\r\ndescription: Prepare release\r\n---\r\nReview the checklist.\r\n"), 0600); err != nil {
		t.Fatal(err)
	}
	skill, ok := readPluginSkill(root, "test.plugin", json.RawMessage(`{"path":"release.md","id":"make-release","name":"Release notes"}`))
	if !ok || skill.ID != "test.plugin/make-release" || skill.Name != "Release notes" ||
		skill.Description != "Prepare release" || skill.Body != "Review the checklist." {
		t.Fatalf("invalid skill: %#v %v", skill, ok)
	}
	if skill, ok := readPluginSkill(root, "test.plugin", json.RawMessage(`"release.md"`)); !ok || skill.ID != "test.plugin/release" {
		t.Fatalf("short skill contribution: %#v %v", skill, ok)
	}
	if _, ok := readPluginSkill(root, "test.plugin", json.RawMessage(`"../release.md"`)); ok {
		t.Fatal("accepted a skill outside its installed plugin")
	}
}

func TestPluginMCPTransportGrant(t *testing.T) {
	const public = `{"id":"tools","transport":"http","url":"https://service.example.test/mcp","headers":{"Authorization":"Bearer fixture"}}`
	const local = `{"id":"tools","transport":"http","url":"http://127.0.0.1:1991/mcp"}`
	tests := []struct {
		name          string
		entry         string
		domains       []string
		localGrant    bool
		want, isLocal bool
	}{
		{"exact domain", public, []string{"service.example.test"}, false, true, false},
		{"wildcard domain", public, []string{"*.example.test"}, false, true, false},
		{"unapproved domain", public, []string{"*.other.test"}, false, false, false},
		{"literal loopback", local, []string{"127.0.0.1"}, true, true, true},
		{"missing local grant", local, []string{"127.0.0.1"}, false, false, false},
		{"stdio", `{"id":"tools","transport":"stdio","command":"my-mcp"}`, nil, true, false, false},
		{"dynamic header", `{"id":"tools","transport":"http","url":"https://service.example.test/mcp","headers":{"Authorization":{"setting":"secret"}}}`,
			[]string{"service.example.test"}, false, false, false},
		{"host override", `{"id":"tools","transport":"http","url":"https://service.example.test/mcp","headers":{"Host":"unauthorized.example.test"}}`,
			[]string{"service.example.test"}, false, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server, ok := readPluginMCP("test.plugin", tt.domains, tt.localGrant, json.RawMessage(tt.entry))
			if ok != tt.want || ok && (server.ID != "test.plugin/tools" || server.Local != tt.isLocal) {
				t.Fatalf("invalid server registration status: allowed=%v local=%v", ok, server.Local)
			}
		})
	}
}
