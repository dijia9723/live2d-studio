// stdio.go 负责插件声明的本地 stdio MCP 服务：声明校验、桌面授权与环境参数绑定。
package piplugins

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"server/internal/pkg"

	"github.com/gin-gonic/gin"
)

var (
	stdioID      = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,63}$`)
	stdioSetting = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,79}$`)
	stdioEnvKey  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,79}$`)
	bareCommand  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.+-]{0,99}$`)
)

// stdioDeclaration 是清单中一个 stdio MCP 服务的声明，Env 的值可以是字面量或设置项引用。
type stdioDeclaration struct {
	ID, Label, Command string
	Args               []string
	Env                map[string]json.RawMessage
}

// stdioGrant 记录用户为该服务填写的敏感参数，只在桌面授权后随进程注入。
type stdioGrant struct {
	Environment map[string]string `json:"environment,omitempty"`
}

// stdioView 是返回前端的服务状态，只暴露环境变量名与就绪状态，不包含任何密钥值。
type stdioView struct {
	ID          string   `json:"id"`
	Label       string   `json:"label"`
	Command     string   `json:"command"`
	Args        []string `json:"args"`
	Environment []string `json:"environment"`
	Settings    []string `json:"settings"`
	Approved    bool     `json:"approved"`
	Ready       bool     `json:"ready"`
}

// StdioConfig 是交给宿主实际启动 MCP 进程的配置；Redact 列出需要在日志中脱敏的值。
type StdioConfig struct {
	ID      string            `json:"id"`
	Label   string            `json:"label"`
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Cwd     string            `json:"cwd"`
	Env     map[string]string `json:"env"`
	Redact  []string          `json:"redact,omitempty"`
}

// stdioDeclarations 解析并过滤 stdio 服务声明：要求 mcp.server.local 权限，
// 并校验 ID、命令、参数与环境变量，非法条目直接丢弃而不是让整个清单失败。
func (m Manifest) stdioDeclarations() []stdioDeclaration {
	if !slices.Contains(m.Permissions, "mcp.server.local") {
		return nil
	}
	var contributes struct {
		MCP []struct {
			Transport string
			stdioDeclaration
		} `json:"mcpServers"`
	}
	if json.Unmarshal(m.Contributes, &contributes) != nil {
		return nil
	}
	var result []stdioDeclaration
	seen := make(map[string]bool)
	for _, entry := range contributes.MCP {
		d := entry.stdioDeclaration
		if entry.Transport != "stdio" || !stdioID.MatchString(d.ID) || seen[d.ID] ||
			len(d.Command) > 300 || !validStdioCommand(d.Command) || len(d.Args) > 48 || len(d.Env) > 32 {
			continue
		}
		if slices.ContainsFunc(d.Args, func(arg string) bool { return len(arg) > 3000 || strings.ContainsRune(arg, 0) }) {
			continue
		}
		valid := true
		for key, value := range d.Env {
			_, _, accepted := stdioEnvValue(value)
			if !stdioEnvKey.MatchString(key) || !accepted {
				valid = false
				break
			}
		}
		if !valid {
			continue
		}
		seen[d.ID] = true
		result = append(result, d)
	}
	return result
}

// validStdioCommand 允许裸命令名或包内相对路径，拒绝绝对路径、盘符与空字节。
func validStdioCommand(s string) bool {
	if bareCommand.MatchString(s) {
		return true
	}
	relative := strings.TrimPrefix(s, "./")
	_, err := filepath.Localize(relative)
	return err == nil && relative != "." && strings.Contains(s, "/") && !strings.ContainsAny(s, "\\:\x00")
}

// stdioEnvValue 区分环境变量的字面量值与设置项引用：字面量随清单固定，
// 引用值必须由用户在桌面端填写后再注入。
func stdioEnvValue(raw json.RawMessage) (string, string, bool) {
	var value string
	if len(raw) != 0 && raw[0] == '"' && json.Unmarshal(raw, &value) == nil {
		return value, "", len(value) <= 4096 && !strings.ContainsRune(value, 0)
	}
	var setting struct{ Setting string }
	if json.Unmarshal(raw, &setting) != nil || !stdioSetting.MatchString(setting.Setting) {
		return "", "", false
	}
	return "", setting.Setting, true
}

// stdioExecutable 解析可执行文件：裸命令走 PATH，包内路径逐级确认没有符号链接。
func stdioExecutable(root string, command string) (string, error) {
	if bareCommand.MatchString(command) {
		return exec.LookPath(command)
	}
	relative, err := filepath.Localize(strings.TrimPrefix(command, "./"))
	if err != nil {
		return "", err
	}
	dir, err := os.OpenRoot(root)
	if err != nil {
		return "", err
	}
	defer dir.Close()
	for check := relative; check != "."; check = filepath.Dir(check) {
		info, err := dir.Lstat(check)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || check == relative && !info.Mode().IsRegular() {
			return "", errors.New("插件内可执行文件不可用")
		}
	}
	return filepath.Abs(filepath.Join(root, relative))
}

// stdioRequiredSettings 汇总服务依赖的设置项名，用于授权时强制填写。
func stdioRequiredSettings(d stdioDeclaration) []string {
	names := make([]string, 0)
	for _, value := range d.Env {
		_, setting, valid := stdioEnvValue(value)
		if valid && setting != "" {
			names = append(names, setting)
		}
	}
	slices.Sort(names)
	return slices.Compact(names)
}

// stdioServers 返回插件的 stdio 服务列表及授权、可执行文件检查结果。
func (m *Module) stdioServers(c *gin.Context) {
	m.mu.Lock()
	defer m.mu.Unlock()
	state, err := m.readStorage()
	if err != nil {
		pkg.Fail(c, 500, "无法读取插件设置")
		return
	}
	record, exists := state.Local[c.Param("id")]
	if !exists {
		pkg.Fail(c, 404, "找不到已安装的插件")
		return
	}
	installed, err := m.openInstalled(record)
	if err != nil {
		pkg.Fail(c, 409, err.Error())
		return
	}
	servers := make([]stdioView, 0)
	for _, d := range installed.Manifest.stdioDeclarations() {
		names := make([]string, 0, len(d.Env))
		for name := range d.Env {
			names = append(names, name)
		}
		slices.Sort(names)
		_, approved := record.StdioGrants[d.ID]
		_, err := stdioExecutable(installed.Root, d.Command)
		servers = append(servers, stdioView{
			ID: d.ID, Label: d.Label, Command: d.Command, Args: d.Args,
			Environment: names, Settings: stdioRequiredSettings(d), Approved: approved, Ready: err == nil,
		})
	}
	pkg.OK(c, servers)
}

// updateStdioGrant 授予或撤销单个 stdio 服务：授权必须在桌面端完成，且敏感参数只能写入已声明的设置项。
func (m *Module) updateStdioGrant(c *gin.Context) {
	var body struct {
		Approved    *bool             `json:"approved"`
		Environment map[string]string `json:"environment"`
	}
	if c.ShouldBindJSON(&body) != nil || body.Approved == nil || len(body.Environment) > 32 {
		pkg.Fail(c, 400, "MCP 授权参数无效")
		return
	}
	if *body.Approved && (m.desktopAvailable == nil || !m.desktopAvailable()) {
		pkg.Fail(c, 409, "本地 MCP 进程需要在桌面客户端授权")
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	state, err := m.readStorage()
	if err != nil {
		pkg.Fail(c, 500, "无法读取插件设置")
		return
	}
	id, serverID := c.Param("id"), c.Param("server")
	record, exists := state.Local[id]
	if !exists {
		pkg.Fail(c, 404, "找不到已安装的插件")
		return
	}
	if *body.Approved {
		installed, err := m.openInstalled(record)
		if err != nil {
			pkg.Fail(c, 409, err.Error())
			return
		}
		servers := installed.Manifest.stdioDeclarations()
		idx := slices.IndexFunc(servers, func(d stdioDeclaration) bool { return d.ID == serverID })
		if idx < 0 {
			pkg.Fail(c, 404, "找不到本地 MCP 服务")
			return
		}
		keys := stdioRequiredSettings(servers[idx])
		if record.StdioGrants == nil {
			record.StdioGrants = make(map[string]stdioGrant)
		}
		environment := make(map[string]string, len(keys))
		for key, value := range body.Environment {
			if !slices.Contains(keys, key) || !utf8.ValidString(value) || len(value) > 4096 || strings.ContainsRune(value, 0) {
				pkg.Fail(c, 400, "MCP 环境变量值无效")
				return
			}
			environment[key] = value
		}
		for _, key := range keys {
			if environment[key] == "" {
				environment[key] = record.StdioGrants[serverID].Environment[key]
			}
			if environment[key] == "" {
				pkg.Fail(c, 400, "请填写 MCP 服务要求的参数")
				return
			}
		}
		record.StdioGrants[serverID] = stdioGrant{Environment: environment}
	} else {
		delete(record.StdioGrants, serverID)
	}
	state.Local[id] = record
	if err := m.writeStorage(state); err != nil {
		pkg.Fail(c, 500, "无法保存 MCP 授权")
		return
	}
	pkg.OK(c, nil)
}

// ApprovedStdio 只返回桌面用户逐项授权、且插件仍启用的确切已安装命令，
// 环境变量在白名单基础上再叠加授权值，并把敏感值记录到 Redact 供日志脱敏。
func (m *Module) ApprovedStdio() []StdioConfig {
	if m.desktopAvailable == nil || !m.desktopAvailable() {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	state, err := m.readStorage()
	if err != nil {
		return nil
	}
	var servers []StdioConfig
	for id, record := range state.Local {
		if !record.Enabled || len(record.StdioGrants) == 0 {
			continue
		}
		installed, err := m.openInstalled(record)
		if err != nil {
			continue
		}
		for _, d := range installed.Manifest.stdioDeclarations() {
			grant, approved := record.StdioGrants[d.ID]
			if !approved {
				continue
			}
			command, err := stdioExecutable(installed.Root, d.Command)
			cwd, cwdErr := filepath.Abs(installed.Root)
			if err != nil || cwdErr != nil {
				continue
			}
			env := make(map[string]string, len(d.Env)+10)
			for _, name := range []string{"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG"} {
				if value := os.Getenv(name); value != "" {
					env[name] = value
				}
			}
			var redact []string
			for key, raw := range d.Env {
				value, setting, _ := stdioEnvValue(raw)
				if setting != "" {
					value = grant.Environment[setting]
					if value != "" {
						redact = append(redact, value)
					}
				}
				env[key] = value
			}
			servers = append(servers, StdioConfig{
				ID: id + "/" + d.ID, Label: d.Label, Command: command, Args: d.Args, Env: env, Cwd: cwd, Redact: redact,
			})
		}
	}
	slices.SortFunc(servers, func(a, b StdioConfig) int { return strings.Compare(a.ID, b.ID) })
	return servers[:min(12, len(servers))]
}
