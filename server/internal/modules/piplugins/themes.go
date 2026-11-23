// themes.go 负责把插件贡献的限白名单 CSS 调色板转换为工作台主题令牌。
package piplugins

import (
	"encoding/json"
	"os"
	"path"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"server/internal/pkg"

	"github.com/gin-gonic/gin"
)

// 单个主题 CSS 的上限，避免插件用超大文件拖慢主题接口。
const maxThemeSize = 256 << 10

// themeContribution 是清单中一条主题声明，Path 指向包内 CSS 文件。
type themeContribution struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Path  string `json:"path"`
	Base  string `json:"base"`
}

// valid 校验主题 ID、标签、CSS 扩展名与底色，避免明显非法的声明进入渲染流程。
func (t themeContribution) valid() bool {
	return themeContributionID.MatchString(t.ID) && strings.TrimSpace(t.Label) != "" &&
		utf8.RuneCountInString(t.Label) <= 100 && strings.EqualFold(path.Ext(t.Path), ".css") &&
		(t.Base == "" || t.Base == "light" || t.Base == "dark")
}

// codingTheme 是前端直接消费的主题对象，Tokens 已经过白名单提炼与默认值补全。
type codingTheme struct {
	ID       string            `json:"id"`
	PluginID string            `json:"plugin_id"`
	Label    string            `json:"label"`
	Base     string            `json:"base"`
	Tokens   map[string]string `json:"tokens"`
}

var (
	themeContributionID = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`)
	cssNonDeclarations  = regexp.MustCompile(`(?s)/\*.*?\*/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`)
	validThemeColor     = regexp.MustCompile(`^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$`)
)

// themeTokens 把插件可写的 --ds-* 变量映射到工作台内部令牌，
// 未列出的声明一律忽略，插件无法借此注入任意 CSS。
var themeTokens = map[string]string{
	"--ds-bg-primary":     "--code-surface",
	"--ds-bg-secondary":   "--code-rail",
	"--ds-bg-tertiary":    "--code-active",
	"--ds-border":         "--code-line",
	"--ds-border-subtle":  "--code-line",
	"--ds-text-primary":   "--code-text",
	"--ds-text-secondary": "--code-muted",
	"--ds-text-muted":     "--code-muted",
	"--ds-accent":         "--code-accent",
}

// allowedThemeTokens 先剥离注释与字符串，再只提取白名单变量且值为十六进制颜色的声明，
// 从而既忽略 @import 等语句，也避免把 content 中的伪声明当成主题颜色。
func allowedThemeTokens(css string) map[string]string {
	values := make(map[string]string)
	css = cssNonDeclarations.ReplaceAllString(css, " ")
	for _, declaration := range strings.FieldsFunc(css, func(r rune) bool {
		return r == '{' || r == '}' || r == ';'
	}) {
		key, value, ok := strings.Cut(strings.TrimSpace(declaration), ":")
		token := themeTokens[strings.TrimSpace(key)]
		if value = strings.TrimSpace(value); ok && token != "" && validThemeColor.MatchString(value) {
			values[token] = value
		}
	}
	return values
}

// themeDefaults 提供亮/暗两套兜底令牌，插件只需覆盖关心的颜色。
func themeDefaults(base string) map[string]string {
	if base == "light" {
		return map[string]string{
			"--code-surface": "#faf8fc", "--code-rail": "#f2edf6", "--code-active": "#e9def3",
			"--code-line": "#dad0e3", "--code-text": "#272031", "--code-muted": "#66596f",
			"--code-accent": "#65488e",
		}
	}
	return map[string]string{
		"--code-surface": "#1b1920", "--code-rail": "#221f29", "--code-active": "#3c304b",
		"--code-line": "#38333f", "--code-text": "#f0ebf5", "--code-muted": "#b6aabd",
		"--code-accent": "#ceb4ff",
	}
}

// readCodingTheme 读取包内 CSS 并要求至少解析出一个白名单颜色，否则视为无效主题。
func readCodingTheme(root *os.Root, pluginID string, item themeContribution) (codingTheme, bool) {
	local, err := packagePath(item.Path)
	if err != nil || !item.valid() {
		return codingTheme{}, false
	}
	info, err := root.Lstat(local)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxThemeSize {
		return codingTheme{}, false
	}
	file, err := root.Open(local)
	if err != nil {
		return codingTheme{}, false
	}
	defer file.Close()
	data, err := readLimited(file, maxThemeSize)
	if err != nil || !utf8.Valid(data) {
		return codingTheme{}, false
	}
	colors := allowedThemeTokens(string(data))
	if len(colors) == 0 {
		return codingTheme{}, false
	}
	base := item.Base
	if base == "" {
		base = "dark"
	}
	tokens := themeDefaults(base)
	for name, value := range colors {
		tokens[name] = value
	}
	return codingTheme{
		ID: pluginID + "/" + item.ID, PluginID: pluginID, Label: strings.TrimSpace(item.Label), Base: base, Tokens: tokens,
	}, true
}

// installationThemes 收集单个插件声明的主题；缺少 ui.theme 权限时不返回任何内容。
func installationThemes(installation Installation, available int) []codingTheme {
	manifest := installation.Manifest
	if !slices.Contains(manifest.Permissions, "ui.theme") {
		return nil
	}
	var contributions struct {
		Themes []themeContribution `json:"themes"`
	}
	if json.Unmarshal(manifest.Contributes, &contributions) != nil || len(contributions.Themes) == 0 {
		return nil
	}
	root, err := os.OpenRoot(installation.Root)
	if err != nil {
		return nil
	}
	defer root.Close()
	found := make([]codingTheme, 0, min(len(contributions.Themes), available))
	for _, item := range contributions.Themes {
		if theme, ok := readCodingTheme(root, manifest.ID, item); ok {
			found = append(found, theme)
			if len(found) == available {
				break
			}
		}
	}
	return found
}

// themes 汇总所有已启用插件的主题，并限制总数防止前端加载过多样式。
func (m *Module) themes(c *gin.Context) {
	installations, err := m.EnabledInstallations()
	if installations == nil && err != nil {
		pkg.Fail(c, 500, "读取插件主题失败")
		return
	}
	const maxThemes = 48
	themes := make([]codingTheme, 0)
	for _, installation := range installations {
		themes = append(themes, installationThemes(installation, maxThemes-len(themes))...)
		if len(themes) == maxThemes {
			break
		}
	}
	pkg.OK(c, themes)
}
