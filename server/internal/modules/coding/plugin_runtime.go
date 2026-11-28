// plugin_runtime.go 负责汇总已启用插件提供的技能、MCP 服务与 stdio 配置。
package coding

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"server/internal/modules/piplugins"

	"golang.org/x/net/http/httpguts"
	"gopkg.in/yaml.v3"
)

const (
	maxPluginSkillBytes = 48 << 10
	maxPluginSkillTotal = 384 << 10
)

var pluginMCPID = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`)

type pluginRuntimeConfig struct {
	Skills []pluginSkill           `json:"skills,omitempty"`
	MCP    []pluginMCPServer       `json:"mcp,omitempty"`
	Stdio  []piplugins.StdioConfig `json:"stdio,omitempty"`
}

type pluginSkill struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Body        string `json:"body"`
}

type pluginMCPServer struct {
	ID      string            `json:"id"`
	Label   string            `json:"label,omitempty"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
	Local   bool              `json:"local,omitempty"`
}

// loadPluginRuntime 汇总已启用插件的技能与 MCP 服务，并受数量与体积预算限制，避免撑爆模型上下文。
func loadPluginRuntime(ctx context.Context, registry *piplugins.Module) (pluginRuntimeConfig, error) {
	var config pluginRuntimeConfig
	if registry == nil {
		return config, nil
	}
	config.Stdio = registry.ApprovedStdio()
	installations, err := registry.EnabledInstallations()
	if installations == nil && err != nil {
		return config, err
	}
	if err != nil {
		slog.Warn("跳过无法重新验证的 Pi 插件")
	}
	seenSkills, seenServers := make(map[string]bool), make(map[string]bool)
	skillBytes := 0
	for _, installation := range installations {
		if err := ctx.Err(); err != nil {
			return config, err
		}
		manifest := installation.Manifest
		var contributions struct {
			Skills []json.RawMessage `json:"skills"`
			MCP    []json.RawMessage `json:"mcpServers"`
		}
		if json.Unmarshal(manifest.Contributes, &contributions) != nil {
			continue
		}
		if slices.Contains(manifest.Permissions, "agent.prompt.inject") {
			for _, entry := range contributions.Skills {
				if len(config.Skills) >= 32 || skillBytes >= maxPluginSkillTotal {
					break
				}
				skill, ok := readPluginSkill(installation.Root, manifest.ID, entry)
				if ok && !seenSkills[skill.ID] && skillBytes+len(skill.Body) <= maxPluginSkillTotal {
					seenSkills[skill.ID] = true
					config.Skills = append(config.Skills, skill)
					skillBytes += len(skill.Body)
				}
			}
		}
		if slices.Contains(manifest.Permissions, "mcp.server.remote") {
			localGrant := slices.Contains(manifest.Permissions, "mcp.server.local")
			for _, entry := range contributions.MCP {
				if len(config.MCP) >= 12 {
					break
				}
				server, ok := readPluginMCP(manifest.ID, manifest.Net.Domains, localGrant, entry)
				if ok && !seenServers[server.ID] {
					seenServers[server.ID] = true
					config.MCP = append(config.MCP, server)
				}
			}
		}
	}
	return config, nil
}

func readPluginSkill(rootPath, pluginID string, raw json.RawMessage) (pluginSkill, bool) {
	var contribution struct {
		Path, ID, Name, Description string
	}
	if json.Unmarshal(raw, &contribution.Path) != nil && json.Unmarshal(raw, &contribution) != nil {
		return pluginSkill{}, false
	}
	ext := path.Ext(contribution.Path)
	if !strings.EqualFold(ext, ".md") && !strings.EqualFold(ext, ".markdown") {
		return pluginSkill{}, false
	}
	local, err := filepath.Localize(contribution.Path)
	if err != nil {
		return pluginSkill{}, false
	}
	if contribution.ID == "" {
		contribution.ID = strings.TrimSuffix(path.Base(contribution.Path), ext)
	}
	if contribution.ID == "" || len(contribution.ID) > 110 || strings.ContainsAny(contribution.ID, "\r\n/\\\x00") {
		return pluginSkill{}, false
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return pluginSkill{}, false
	}
	defer root.Close()
	info, err := root.Lstat(local)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxPluginSkillBytes {
		return pluginSkill{}, false
	}
	file, err := root.Open(local)
	if err != nil {
		return pluginSkill{}, false
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxPluginSkillBytes+1))
	if err != nil || len(data) > maxPluginSkillBytes || !utf8.Valid(data) {
		return pluginSkill{}, false
	}
	var metadata struct {
		Name        string `yaml:"name"`
		Description string `yaml:"description"`
	}
	content := bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
	if bytes.HasPrefix(content, []byte("---\n")) {
		before, after, ok := bytes.Cut(content[4:], []byte("\n---\n"))
		if ok && len(before) <= 8<<10 && yaml.Unmarshal(before, &metadata) == nil {
			content = after
		}
	}
	body := strings.TrimSpace(string(content))
	name := firstSkillValue(contribution.Name, metadata.Name, contribution.ID)
	return pluginSkill{
		ID: pluginID + "/" + contribution.ID, Name: boundedPluginText(name, 100),
		Description: boundedPluginText(firstSkillValue(contribution.Description, metadata.Description), 280), Body: body,
	}, body != ""
}

func firstSkillValue(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func boundedPluginText(value string, maxRunes int) string {
	runes := []rune(strings.Join(strings.Fields(value), " "))
	return string(runes[:min(len(runes), maxRunes)])
}

// readPluginMCP 校验插件声明的远程 MCP 服务：只允许 HTTPS（本地回环需显式授权），
// 域名必须命中清单，并拒绝可篡改请求语义的敏感请求头。
func readPluginMCP(pluginID string, domains []string, localGrant bool, raw json.RawMessage) (pluginMCPServer, bool) {
	var entry struct {
		ID, Label, Transport, URL string
		Headers                   map[string]string
	}
	if json.Unmarshal(raw, &entry) != nil || entry.Transport != "http" || !pluginMCPID.MatchString(entry.ID) || len(entry.URL) > 2048 {
		return pluginMCPServer{}, false
	}
	endpoint, err := url.Parse(entry.URL)
	if err != nil || endpoint.Hostname() == "" || endpoint.User != nil || endpoint.Fragment != "" {
		return pluginMCPServer{}, false
	}
	host := strings.ToLower(endpoint.Hostname())
	local := host == "127.0.0.1" || host == "::1" || host == "localhost"
	if (endpoint.Scheme != "https" && !(local && endpoint.Scheme == "http")) ||
		(local && !localGrant) || !authorizedMCPDomain(host, domains) {
		return pluginMCPServer{}, false
	}
	if ip := net.ParseIP(host); ip != nil && !local && (ip.IsPrivate() || !ip.IsGlobalUnicast()) {
		return pluginMCPServer{}, false
	}
	if len(entry.Headers) > 24 {
		return pluginMCPServer{}, false
	}
	for key, value := range entry.Headers {
		if len(key) > 80 || len(value) > 4096 || !httpguts.ValidHeaderFieldName(key) || !httpguts.ValidHeaderFieldValue(value) {
			return pluginMCPServer{}, false
		}
		switch strings.ToLower(key) {
		case "host", "connection", "content-length", "transfer-encoding", "upgrade", "proxy-authorization",
			"proxy-connection", "cookie", "accept-encoding":
			return pluginMCPServer{}, false
		}
	}
	return pluginMCPServer{
		ID: pluginID + "/" + entry.ID, Label: boundedPluginText(entry.Label, 100), URL: endpoint.String(),
		Headers: entry.Headers, Local: local,
	}, true
}

func authorizedMCPDomain(host string, domains []string) bool {
	for _, domain := range domains {
		domain = strings.ToLower(strings.TrimSpace(domain))
		if domain == host {
			return true
		}
		if suffix, wildcard := strings.CutPrefix(domain, "*."); wildcard && strings.Contains(suffix, ".") &&
			(host == suffix || strings.HasSuffix(host, "."+suffix)) {
			return true
		}
	}
	return false
}
