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

func validPluginID(id string) bool {
	first, _, _ := strings.Cut(id, ".")
	return len(id) <= 150 && pluginID.MatchString(id) && !reservedWinName(first)
}

func reservedWinName(name string) bool {
	stem, _, _ := strings.Cut(name, ".")
	switch stem = strings.ToLower(strings.TrimRight(stem, " ")); stem {
	case "con", "prn", "aux", "nul":
		return true
	}
	return len([]rune(stem)) == 4 && (strings.HasPrefix(stem, "com") || strings.HasPrefix(stem, "lpt")) &&
		strings.ContainsRune("0123456789¹²³", []rune(stem)[3])
}

// packagePath rejects aliases that are legal on Unix but may resolve differently on Windows.
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

func localize(name, description, safety string, translations map[string]pluginTranslation) (string, string, string) {
	zh := translations["zh-CN"]
	en := translations["en"]
	return firstText(zh.Name, en.Name, name), firstText(zh.Description, en.Description, description),
		firstText(zh.SafetyNotes, en.SafetyNotes, safety)
}

func firstText(texts ...string) string {
	for _, text := range texts {
		if strings.TrimSpace(text) != "" {
			return text
		}
	}
	return ""
}

func safeDisplayURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil {
		return ""
	}
	return u.String()
}

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

func referenceURL(base *url.URL, raw string) *url.URL {
	ref, err := url.Parse(raw)
	if err != nil || ref == nil || ref.String() == "" {
		return nil
	}
	return base.ResolveReference(ref)
}

func extension(filename string) string { return strings.ToLower(path.Ext(filename)) }
