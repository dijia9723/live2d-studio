// manifest.go 负责插件清单的定义、路径校验与本地化展示信息生成。
package piplugins

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode"

	"github.com/Masterminds/semver/v3"
)

const maxManifestSize = 512 << 10

var pluginID = regexp.MustCompile(`^[a-z0-9]+(\.[a-z0-9_-]+)+$`)

type pluginTranslation struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	SafetyNotes string `json:"safetyNotes"`
}

// Manifest 是 manifest.json 的映射，描述插件身份、入口、权限与各类贡献声明。
// Permissions 是后续所有能力裁剪与授权的唯一依据。
type Manifest struct {
	SchemaVersion int                          `json:"schemaVersion"`
	ID            string                       `json:"id"`
	Name          string                       `json:"name"`
	Version       string                       `json:"version"`
	Description   string                       `json:"description"`
	Author        json.RawMessage              `json:"author"`
	Homepage      string                       `json:"homepage"`
	Repository    string                       `json:"repository"`
	SafetyNotes   string                       `json:"safetyNotes"`
	I18n          map[string]pluginTranslation `json:"i18n"`
	Main          string                       `json:"main"`
	Renderer      string                       `json:"renderer"`
	Icon          string                       `json:"icon"`
	UI            struct {
		Panel string `json:"panel"`
	} `json:"ui"`
	Permissions []string        `json:"permissions"`
	Contributes json.RawMessage `json:"contributes"`
	FS          struct {
		Read struct {
			Root  string   `json:"root"`
			Scope []string `json:"scope"`
		} `json:"read"`
	} `json:"fs"`
	Net struct {
		Domains []string `json:"domains"`
	} `json:"net"`
}

// validPluginID 要求反向域名式的小写 ID，并排除 Windows 保留设备名，
// 因为插件 ID 会参与目录与文件名拼装。
func validPluginID(id string) bool {
	first, _, _ := strings.Cut(id, ".")
	return len(id) <= 150 && pluginID.MatchString(id) && !reservedWinName(first)
}

// reservedWinName 识别 CON、NUL、COM1 等 Windows 保留名，避免创建文件时行为不一致。
func reservedWinName(name string) bool {
	stem, _, _ := strings.Cut(name, ".")
	switch stem = strings.ToLower(strings.TrimRight(stem, " ")); stem {
	case "con", "prn", "aux", "nul":
		return true
	}
	return len([]rune(stem)) == 4 && (strings.HasPrefix(stem, "com") || strings.HasPrefix(stem, "lpt")) &&
		strings.ContainsRune("0123456789¹²³", []rune(stem)[3])
}

// packagePath 拒绝在 Unix 合法但在 Windows 上可能解析到其他位置的别名，
// 同时拦截绝对路径、控制字符、尾部空格点和保留设备名，确保解包始终落在插件根目录内。
func packagePath(name string) (string, error) {
	if name == "." || !filepath.IsLocal(name) || strings.ContainsAny(name, `\:<>"|?*`) || len(name) > 512 {
		return "", errors.New("插件包含有无效的文件路径")
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." || strings.TrimRight(part, " .") != part ||
			reservedWinName(part) || strings.ContainsFunc(part, unicode.IsControl) {
			return "", errors.New("插件包含有无效的文件路径")
		}
	}
	return filepath.Localize(name)
}

// readLimited 多读一个字节用于判断是否超限，避免把超大输入整体读入内存。
func readLimited(reader io.Reader, max int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, errors.New("数据超过大小限制")
	}
	return data, nil
}

// readManifest 读取并校验清单的结构约束：版本号、ID、名称、语义化版本与所有声明的入口文件，
// 返回原始字节供调用方计算哈希，防止安装后清单被替换。
func readManifest(root *os.Root) (Manifest, []byte, error) {
	file, err := root.Open("manifest.json")
	if err != nil {
		return Manifest{}, nil, errors.New("插件包根目录缺少 manifest.json")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return Manifest{}, nil, errors.New("插件清单不是普通文件")
	}
	data, err := readLimited(file, maxManifestSize)
	if err != nil {
		return Manifest{}, nil, err
	}
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return Manifest{}, nil, errors.New("插件清单 JSON 格式无效")
	}
	if manifest.SchemaVersion != 1 || !validPluginID(manifest.ID) || strings.TrimSpace(manifest.Name) == "" ||
		len(manifest.Name) > 512 || len(manifest.Version) > 128 || manifest.Main == "" {
		return Manifest{}, nil, errors.New("插件清单需要版本 1、合法 ID、名称、版本和入口")
	}
	if _, err := semver.StrictNewVersion(manifest.Version); err != nil {
		return Manifest{}, nil, errors.New("插件版本需要符合语义化版本格式")
	}
	if err := manifest.validatePaths(root); err != nil {
		return Manifest{}, nil, err
	}
	return manifest, data, nil
}

// validatePaths 确认清单声明的入口、视图、主题、Skill 与可信扩展都是包内真实存在的普通文件。
func (m Manifest) validatePaths(root *os.Root) error {
	if _, err := m.trustedExtensionPaths(); err != nil {
		return err
	}
	check := func(file string) error {
		if file == "" {
			return nil
		}
		p, err := packagePath(file)
		if err != nil {
			return err
		}
		info, err := root.Stat(p)
		if err != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("插件包缺少入口文件 %s", file)
		}
		return nil
	}
	for _, file := range []string{m.Main, m.Renderer, m.Icon, m.UI.Panel} {
		if err := check(file); err != nil {
			return err
		}
	}
	var declarations struct {
		Views []struct {
			Entry string `json:"entry"`
		} `json:"views"`
		Skills     []json.RawMessage   `json:"skills"`
		Themes     []themeContribution `json:"themes"`
		Extensions []string            `json:"agentExtensions"`
	}
	if len(m.Contributes) > 0 && json.Unmarshal(m.Contributes, &declarations) != nil {
		return errors.New("插件清单的能力声明格式无效")
	}
	files := slices.Clone(declarations.Extensions)
	for _, view := range declarations.Views {
		files = append(files, view.Entry)
	}
	themeIDs := make(map[string]bool, len(declarations.Themes))
	for _, theme := range declarations.Themes {
		if !theme.valid() || themeIDs[theme.ID] || !slices.Contains(m.Permissions, "ui.theme") {
			return errors.New("插件主题需要合法的 ID、标签、CSS 路径、底色和 ui.theme 权限")
		}
		themeIDs[theme.ID] = true
		files = append(files, theme.Path)
	}
	for _, skill := range declarations.Skills {
		var entry string
		if json.Unmarshal(skill, &entry) != nil {
			var value struct {
				Path string `json:"path"`
			}
			if json.Unmarshal(skill, &value) != nil {
				return errors.New("插件清单的 Skill 路径格式无效")
			}
			entry = value.Path
		}
		files = append(files, entry)
	}
	for _, file := range files {
		if file == "" {
			return errors.New("插件清单的能力声明缺少路径")
		}
		if err := check(file); err != nil {
			return err
		}
	}
	return nil
}

// localize 按中文、英文、原始文本的顺序取第一个非空值，保证界面始终有可展示文案。
func localize(name, description, safety string, translations map[string]pluginTranslation) (string, string, string) {
	zh := translations["zh-CN"]
	en := translations["en"]
	return firstText(zh.Name, en.Name, name), firstText(zh.Description, en.Description, description),
		firstText(zh.SafetyNotes, en.SafetyNotes, safety)
}

// firstText 返回第一个去空白后非空的字符串。
func firstText(texts ...string) string {
	for _, text := range texts {
		if strings.TrimSpace(text) != "" {
			return text
		}
	}
	return ""
}

// safeDisplayURL 只放行 http(s) 且不含用户信息的地址，避免把 javascript: 等协议带入前端。
func safeDisplayURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil {
		return ""
	}
	return u.String()
}

// plugin 生成对外的插件摘要，只保留当前版本实际支持的能力即 Supported，
// 便于前端在启用前判断插件能否在当前工作台运行。
func (m Manifest) plugin() Plugin {
	name, description, safety := localize(m.Name, m.Description, m.SafetyNotes, m.I18n)
	var author string
	if json.Unmarshal(m.Author, &author) != nil {
		var contact struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(m.Author, &contact) == nil {
			author = contact.Name
		}
	}
	var contributions map[string]json.RawMessage
	_ = json.Unmarshal(m.Contributes, &contributions)
	keys := make([]string, 0, len(contributions)+2)
	for key, value := range contributions {
		switch string(bytes.TrimSpace(value)) {
		case "null", "false", "[]", "{}":
		default:
			keys = append(keys, key)
		}
	}
	if m.UI.Panel != "" {
		keys = append(keys, "panel")
	}
	if m.Renderer != "" {
		keys = append(keys, "renderer")
	}
	slices.Sort(keys)
	keys = slices.Compact(keys)
	supported := make([]string, 0, 2)
	if slices.Contains(keys, "skills") && slices.Contains(m.Permissions, "agent.prompt.inject") {
		supported = append(supported, "skills")
	}
	if len(m.stdioDeclarations()) > 0 {
		supported = append(supported, "mcpStdio")
	}
	if entries, _ := m.trustedExtensionPaths(); len(entries) > 0 {
		supported = append(supported, trustedExtensionCapability)
	}
	supported = append(supported, m.hostCapabilities()...)
	if slices.Contains(keys, "themes") && slices.Contains(m.Permissions, "ui.theme") {
		supported = append(supported, "themes")
	}
	if slices.Contains(keys, "mcpServers") && slices.Contains(m.Permissions, "mcp.server.remote") {
		var servers []struct {
			Transport string `json:"transport"`
		}
		_ = json.Unmarshal(contributions["mcpServers"], &servers)
		for _, server := range servers {
			if server.Transport == "http" {
				supported = append(supported, "mcpServers")
				break
			}
		}
	}
	return Plugin{ID: m.ID, Name: name, Version: m.Version, Description: description, Author: author,
		SafetyNotes: safety, Homepage: safeDisplayURL(m.Homepage), Repository: safeDisplayURL(m.Repository),
		Permissions: append([]string{}, m.Permissions...), Contributions: keys, Supported: slices.Compact(supported)}
}

// referenceURL 解析相对引用，失败时返回 nil 由调用方跳过该候选地址。
func referenceURL(base *url.URL, raw string) *url.URL {
	ref, err := url.Parse(raw)
	if err != nil || ref == nil || ref.String() == "" {
		return nil
	}
	return base.ResolveReference(ref)
}

// extension 统一返回小写扩展名，便于跨平台比较文件类型。
func extension(filename string) string { return strings.ToLower(path.Ext(filename)) }
