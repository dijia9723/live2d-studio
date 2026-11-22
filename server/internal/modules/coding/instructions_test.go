package coding

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestProjectInstructionPriorityAndBudget(t *testing.T) {
	base := t.TempDir()
	for name, text := range map[string]string{
		"AGENTS.md": "root rules", "AGENTS.override.md": "root override",
		"nested/CLAUDE.md": "nested rules", "nested/deep/AGENTS.md": strings.Repeat("中", projectInstructionBudget),
		"sibling/AGENTS.md": "sibling rules",
	} {
		name = filepath.Join(base, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(name, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	root, err := os.OpenRoot(base)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	got, err := workspaceInstructions(root, "nested/deep")
	if err != nil || len(got) != 3 || got[0].Text != "root override" || got[1].Text != "nested rules" ||
		got[2].Path != "nested/deep/AGENTS.md" || !got[2].Truncated || !utf8.ValidString(got[2].Text) {
		t.Fatalf("incorrect instruction chain: %d sources, %v", len(got), err)
	}
	if len(got[0].Text)+len(got[1].Text)+len(got[2].Text) > projectInstructionBudget {
		t.Fatal("instruction budget exceeded")
	}
	if _, err := workspaceInstructions(root, "../elsewhere"); err == nil {
		t.Fatal("accepted an out-of-workspace path")
	}
}
