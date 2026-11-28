// themes_test.go 覆盖插件主题白名单令牌的解析与权限校验。
package piplugins

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestCompatibleThemePalette(t *testing.T) {
	dir := t.TempDir()
	css := `
		/* --ds-bg-secondary: #123; */
		@import url("https://invalid.example/style.css");
		:root[data-theme="dark"] {
			--ds-bg-primary: #0d1424;
			--ds-bg-secondary: #131c31;
			--ds-bg-tertiary: #1a2440;
			--ds-accent: #8fb4ff;
			--ds-text-primary: var(--another);
			--ds-text-muted: url(https://invalid.example/value);
			--unrelated: #f00;
			content: "; --ds-border: #f00; ";
		}
	`
	if err := os.WriteFile(filepath.Join(dir, "night.css"), []byte(css), 0600); err != nil {
		t.Fatal(err)
	}
	manifest := Manifest{ID: "example.theme", Permissions: []string{"ui.theme"},
		Contributes: json.RawMessage(`{"themes":[{"id":"night","label":"Midnight","path":"night.css","base":"dark"}]}`)}
	themes := installationThemes(Installation{Root: dir, Manifest: manifest}, 8)
	if len(themes) != 1 {
		t.Fatalf("expected a theme, got %v", themes)
	}
	theme := themes[0]
	want := map[string]string{
		"--code-surface": "#0d1424", "--code-rail": "#131c31", "--code-active": "#1a2440",
		"--code-accent": "#8fb4ff", "--code-text": "#f0ebf5", "--code-muted": "#b6aabd", "--code-line": "#38333f",
	}
	if theme.ID != "example.theme/night" || theme.Label != "Midnight" || theme.Base != "dark" || len(theme.Tokens) != len(want) {
		t.Fatalf("invalid theme: %#v", theme)
	}
	for key, value := range want {
		if theme.Tokens[key] != value {
			t.Errorf("%s: got %s, want %s", key, theme.Tokens[key], value)
		}
	}
	manifest.Permissions = nil
	if themes := installationThemes(Installation{Root: dir, Manifest: manifest}, 8); len(themes) != 0 {
		t.Fatalf("published a theme without ui.theme: %v", themes)
	}
}
