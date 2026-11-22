package piplugins

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"server/internal/middleware"
	"server/internal/pkg"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type Plugin struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Version       string     `json:"version"`
	Description   string     `json:"description,omitempty"`
	Author        string     `json:"author,omitempty"`
	Homepage      string     `json:"homepage,omitempty"`
	Repository    string     `json:"repository,omitempty"`
	SafetyNotes   string     `json:"safety_notes,omitempty"`
	Permissions   []string   `json:"permissions"`
	Contributions []string   `json:"contributions"`
	Supported     []string   `json:"supported"`
	Enabled       bool       `json:"enabled"`
	Source        string     `json:"source"`
	InstalledAt   *time.Time `json:"installed_at,omitempty"`
	HostGranted   bool       `json:"host_granted,omitempty"`
	Error         string     `json:"error,omitempty"`
}

type Installation struct {
	Manifest Manifest
	Root     string
	Plugin   Plugin
}

type storedPlugin struct {
	Plugin
	Directory       string                 `json:"directory"`
	ManifestHash    string                 `json:"manifest_hash"`
	StdioGrants     map[string]stdioGrant  `json:"stdio_grants,omitempty"`
	ExtensionDigest string                 `json:"extension_digest,omitempty"`
	ExtensionSize   int64                  `json:"extension_size,omitempty"`
	ExtensionGrant  *trustedExtensionGrant `json:"extension_grant,omitempty"`
}

type storage struct {
	Native map[string]bool         `json:"native"`
	Local  map[string]storedPlugin `json:"local"`
}

type Module struct {
	root             string
	desktopAvailable func() bool
	mu               sync.Mutex
	marketMu         sync.Mutex
	catalog          *marketCatalog
	client           *http.Client
	host             *pluginHost
}

func New(root string, desktopAvailable func() bool) *Module {
	return &Module{root: root, desktopAvailable: desktopAvailable, client: marketClient()}
}

func (m *Module) Register(r *gin.RouterGroup) {
	g := r.Group("/coding/plugins", middleware.WorkspaceOnly(m.desktopAvailable))
	g.GET("", m.list)
	g.GET("/marketplace", m.marketplace)
	g.GET("/themes", m.themes)
	g.POST("/import", m.importPlugin)
	g.POST("/:id/install", m.installMarket)
	g.PUT("/:id", m.enable)
	g.DELETE("/:id", m.remove)
	g.GET("/:id/stdio", m.stdioServers)
	g.PUT("/:id/stdio/:server", m.updateStdioGrant)
	m.RegisterHost(g)
	m.RegisterTrustedExtensions(g)
}

var bundled = []Plugin{
	{
		ID: "pi.browser", Name: "浏览器", Version: "1.0.0", Author: "PI-Desktop", Source: "bundled",
		Description:   "在编码工作台预览网页，并在系统浏览器中打开。",
		Permissions:   []string{"ui.view", "agent.tool.register", "browser.cdp"},
		Contributions: []string{"views", "agentTools"}, Supported: []string{"views"},
	},
	{
		ID: "pi.file-manager", Name: "文件管理器", Version: "0.9.1", Author: "PI-Desktop", Source: "bundled",
		Description:   "在项目面板浏览、搜索、预览和编辑文件，并查看 Git 变更。",
		Permissions:   []string{"ui.view", "fs.read"},
		Contributions: []string{"views"}, Supported: []string{"views"},
	},
	{
		ID: "pi.official-enhancements", Name: "官方增强功能", Version: "0.10.0", Author: "PI-Desktop", Source: "bundled",
		Description:   "为编码会话提供自动标题、提示词增强和后续消息建议。",
		Permissions:   []string{"ui.panel", "composer.transform", "models.list", "agent.complete", "session.read.all", "session.autoTitle", "composer.suggest", "agent.tool.register"},
		Contributions: []string{"panel", "agentTools", "commands", "composerTransforms", "composerSuggestions", "autoTitle"},
		Supported:     []string{"composerTransforms", "composerSuggestions", "autoTitle"},
	},
}

func bundledPlugin(id string) (Plugin, bool) {
	for _, plugin := range bundled {
		if plugin.ID == id {
			return plugin, true
		}
	}
	return Plugin{}, false
}

func (s storage) bundledEnabled(id string) bool {
	value, exists := s.Native[id]
	return !exists || value
}

func (m *Module) readStorage() (storage, error) {
	s := storage{Native: map[string]bool{}, Local: map[string]storedPlugin{}}
	file, err := os.Open(filepath.Join(m.root, "registry.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	defer file.Close()
	data, err := readLimited(file, 16<<20)
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(data, &s); err != nil || s.Native == nil || s.Local == nil {
		return s, errors.New("无法读取插件注册表")
	}
	return s, nil
}

func atomicWrite(dir, name string, content []byte) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".write-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	_, writeErr := tmp.Write(content)
	if err := errors.Join(writeErr, tmp.Close()); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(dir, name))
}

func (m *Module) writeStorage(s storage) error {
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return atomicWrite(m.root, "registry.json", data)
}

func packageDirectory(name string) bool {
	value, ok := strings.CutPrefix(name, "package-")
	return ok && uuid.Validate(value) == nil && len(value) == 36
}

func (m *Module) Enabled(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.readStorage()
	if err != nil {
		return false
	}
	if _, builtin := bundledPlugin(id); builtin {
		return s.bundledEnabled(id)
	}
	return s.Local[id].Enabled
}

func (m *Module) openInstalled(record storedPlugin) (Installation, error) {
	if !packageDirectory(record.Directory) {
		return Installation{}, errors.New("已安装插件的目录无效")
	}
	directory := filepath.Join(m.root, record.Directory)
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return Installation{}, errors.New("已安装插件的目录不可用，请重新导入")
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return Installation{}, err
	}
	defer root.Close()
	manifest, raw, err := readManifest(root)
	if err != nil {
		return Installation{}, err
	}
	hash := sha256.Sum256(raw)
	if hex.EncodeToString(hash[:]) != record.ManifestHash || manifest.ID != record.ID || manifest.Version != record.Version {
		return Installation{}, errors.New("已安装插件的清单有变动，请重新导入")
	}
	return Installation{Manifest: manifest, Root: directory, Plugin: record.Plugin}, nil
}

func (m *Module) EnabledInstallations() ([]Installation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.readStorage()
	if err != nil {
		return nil, err
	}
	installs := make([]Installation, 0)
	var failures []error
	for _, stored := range s.Local {
		if !stored.Enabled {
			continue
		}
		installed, err := m.openInstalled(stored)
		if err == nil {
			installs = append(installs, installed)
		} else {
			failures = append(failures, err)
		}
	}
	slices.SortFunc(installs, func(a, b Installation) int { return strings.Compare(a.Manifest.ID, b.Manifest.ID) })
	return installs, errors.Join(failures...)
}

func (m *Module) list(c *gin.Context) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.readStorage()
	if err != nil {
		pkg.Fail(c, 500, "读取插件注册表失败")
		return
	}
	out := make([]Plugin, 0, len(bundled)+len(s.Local))
	for _, plugin := range bundled {
		plugin.Enabled = s.bundledEnabled(plugin.ID)
		out = append(out, plugin)
	}
	for _, record := range s.Local {
		plugin := record.Plugin
		if installed, err := m.openInstalled(record); err != nil {
			plugin.Error = err.Error()
		} else {
			plugin.Supported = installed.Manifest.plugin().Supported
		}
		out = append(out, plugin)
	}
	slices.SortFunc(out[len(bundled):], func(a, b Plugin) int { return strings.Compare(a.ID, b.ID) })
	pkg.OK(c, out)
}

func (m *Module) enable(c *gin.Context) {
	id := c.Param("id")
	var body struct {
		Enabled *bool `json:"enabled"`
		Execute *bool `json:"execute"`
	}
	if !validPluginID(id) || c.ShouldBindJSON(&body) != nil || body.Enabled == nil {
		pkg.Fail(c, 400, "请选择插件及启用状态")
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.readStorage()
	if err != nil {
		pkg.Fail(c, 500, "读取插件注册表失败")
		return
	}
	plugin, builtin := bundledPlugin(id)
	if builtin {
		plugin.Enabled = *body.Enabled
		s.Native[id] = plugin.Enabled
	} else {
		record, exists := s.Local[id]
		if !exists {
			pkg.Fail(c, 404, "插件未安装")
			return
		}
		if *body.Enabled {
			installed, err := m.openInstalled(record)
			if err != nil {
				pkg.Fail(c, 409, err.Error())
				return
			}
			record.Supported = installed.Manifest.plugin().Supported
			if len(record.Supported) == 0 {
				pkg.Fail(c, 409, "此插件没有当前工作台支持的运行能力")
				return
			}
			if body.Execute != nil && *body.Execute {
				if m.desktopAvailable == nil || !m.desktopAvailable() || len(installed.Manifest.hostCapabilities()) == 0 {
					pkg.Fail(c, 409, "插件运行入口需要在桌面客户端单独授权")
					return
				}
				record.HostGranted = true
			} else if body.Execute != nil {
				record.HostGranted = false
			}
		} else {
			record.HostGranted = false
		}
		record.Enabled = *body.Enabled
		s.Local[id] = record
		plugin = record.Plugin
	}
	if err := m.writeStorage(s); err != nil {
		pkg.Fail(c, 500, "保存插件状态失败")
		return
	}
	go m.RefreshHost(id)
	pkg.OK(c, plugin)
}

func (m *Module) remove(c *gin.Context) {
	id := c.Param("id")
	if _, builtin := bundledPlugin(id); builtin {
		pkg.Fail(c, 409, "内置插件可以关闭")
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.readStorage()
	if err != nil {
		pkg.Fail(c, 500, "读取插件注册表失败")
		return
	}
	record, exists := s.Local[id]
	if !exists {
		pkg.Fail(c, 404, "插件未安装")
		return
	}
	delete(s.Local, id)
	if err := m.writeStorage(s); err != nil {
		pkg.Fail(c, 500, "更新插件注册表失败")
		return
	}
	m.removePackage(record.Directory)
	go m.RefreshHost(id)
	pkg.OK(c, nil)
}

func (m *Module) removePackage(name string) {
	if packageDirectory(name) {
		_ = os.RemoveAll(filepath.Join(m.root, name))
	}
}
