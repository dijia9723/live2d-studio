package coding

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const projectInstructionBudget = 32 << 10

type projectInstruction struct {
	Path      string `json:"path"`
	Text      string `json:"text"`
	Truncated bool   `json:"truncated,omitempty"`
}

func projectInstructions(root *os.Root, directory string) []projectInstruction {
	remaining := projectInstructionBudget
	if strings.Count(directory, string(filepath.Separator)) > 40 {
		return nil
	}
	ancestors := []string{"."}
	if directory != "." && directory != "" {
		parent := ""
		for _, component := range strings.Split(directory, string(filepath.Separator)) {
			parent = filepath.Join(parent, component)
			ancestors = append(ancestors, parent)
		}
	}
	sources := make([]projectInstruction, 0, len(ancestors))
	for _, ancestor := range ancestors {
		for _, name := range []string{"AGENTS.override.md", "AGENTS.md", "CLAUDE.md", filepath.Join(".claude", "CLAUDE.md")} {
			candidate := filepath.Join(ancestor, name)
			source, ok := readProjectInstruction(root, candidate, remaining)
			if !ok {
				continue
			}
			sources = append(sources, source)
			remaining -= len(source.Text)
			if source.Truncated || remaining <= 0 {
				return sources
			}
			break
		}
	}
	return sources
}

func globalInstruction(stateDir string) *projectInstruction {
	root, err := os.OpenRoot(stateDir)
	if err != nil {
		return nil
	}
	defer root.Close()
	source, ok := readProjectInstruction(root, "AGENTS.md", projectInstructionBudget)
	if !ok {
		return nil
	}
	return &source
}

func readProjectInstruction(root *os.Root, local string, limit int) (projectInstruction, bool) {
	if checkFilePath(root, local) != nil {
		return projectInstruction{}, false
	}
	info, err := root.Lstat(local)
	if err != nil || !info.Mode().IsRegular() {
		return projectInstruction{}, false
	}
	file, err := root.Open(local)
	if err != nil {
		return projectInstruction{}, false
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, int64(limit)+1))
	if err != nil {
		return projectInstruction{}, false
	}
	truncated := len(data) > limit
	if truncated {
		data = data[:limit]
		for count := 0; count < utf8.UTFMax && len(data) > 0 && !utf8.Valid(data); count++ {
			data = data[:len(data)-1]
		}
	}
	contents := strings.TrimSpace(string(data))
	if !utf8.Valid(data) || contents == "" || strings.ContainsRune(contents, 0) {
		return projectInstruction{}, false
	}
	return projectInstruction{Path: filepath.ToSlash(local), Text: contents, Truncated: truncated}, true
}

func workspaceInstructions(root *os.Root, target string) ([]projectInstruction, error) {
	directory, err := localPath(target, true)
	if err != nil {
		return nil, err
	}
	if err := checkFilePath(root, directory); err != nil {
		return nil, err
	}
	return projectInstructions(root, directory), nil
}
