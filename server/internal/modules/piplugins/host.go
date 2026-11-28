// host.go 负责桌面宿主侧的插件注册、生命周期与授权状态管理。
package piplugins

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"server/internal/pkg"

	"github.com/gin-gonic/gin"
)

// pluginHost 持有宿主进程所需的可执行文件路径、活跃 worker 与异步事件队列。
// workers 以插件 ID 为键，保证同一插件不会并发启动多个独立进程。
type pluginHost struct {
	workspace    hostWorkspaceCall
	executable   string
	mu           sync.Mutex
	dataMu       sync.Mutex
	completionMu sync.Mutex
	workers      map[string]*hostedWorker
	dispatch     chan struct{}
	async        []hostNotification
	closed       bool
	model        func() (HostCompletionModel, error)
	complete     func(context.Context, HostCompletionRequest) (string, error)
	usage        map[string][]time.Time
}

// hostNotification 是推送给前端的异步事件，附带来源插件 ID 以便窗口路由。
type hostNotification struct {
	PluginID string `json:"plugin_id"`
	hostEvent
}

type hostData struct {
	Settings map[string]json.RawMessage `json:"settings"`
	Storage  map[string]json.RawMessage `json:"storage"`
}

// ConfigureHost 记录当前可执行文件路径并初始化宿主状态；重复调用保持幂等。
func (m *Module) ConfigureHost() {
	if m.host != nil {
		return
	}
	executable, err := os.Executable()
	if err != nil {
		return
	}
	m.host = &pluginHost{executable: executable, workers: make(map[string]*hostedWorker), dispatch: make(chan struct{}, 8)}
}

func (m *Module) hostAvailable() bool {
	return m.host != nil && m.desktopAvailable != nil && m.desktopAvailable()
}

// RegisterHost 挂载宿主运行时查询、命令调用、视图加载与面板桥接接口。
func (m *Module) RegisterHost(g *gin.RouterGroup) {
	g.GET("/runtime", m.hostList)
	g.GET("/runtime/events", m.hostEvents)
	g.GET("/:id/runtime/settings", m.hostSettings)
	g.PUT("/:id/runtime/settings", m.updateHostSettings)
	g.POST("/:id/runtime/command", m.hostCommand)
	g.POST("/:id/runtime/view", m.hostView)
	g.POST("/:id/runtime/bridge", m.hostBridge)
}

// hostInstallations 只返回已启用、已获执行授权且确实声明了宿主能力的插件，
// 避免前端看到当前浏览器版本无法运行的条目。
func (m *Module) hostInstallations() []Installation {
	if !m.hostAvailable() {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	values, err := m.readStorage()
	if err != nil {
		return nil
	}
	resolved := make([]Installation, 0)
	for _, value := range values.Local {
		if value.Enabled && value.HostGranted {
			if item, err := m.openInstalled(value); err == nil && len(item.Manifest.hostCapabilities()) > 0 {
				resolved = append(resolved, item)
			}
		}
	}
	slices.SortFunc(resolved, func(a, b Installation) int { return strings.Compare(a.Manifest.ID, b.Manifest.ID) })
	return resolved
}

// hostInstallation 加载指定插件并要求启用与执行授权同时成立。
// 宿主进程只随桌面客户端启动，因此非桌面环境统一拒绝。
func (m *Module) hostInstallation(id string) (Installation, error) {
	if !m.hostAvailable() || !validPluginID(id) {
		return Installation{}, errors.New("插件执行宿主仅在桌面版可用")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	values, err := m.readStorage()
	if err != nil {
		return Installation{}, errors.New("读取插件状态失败")
	}
	value, found := values.Local[id]
	if !found || !value.Enabled || !value.HostGranted {
		return Installation{}, errors.New("请在插件中心启用该插件并允许执行")
	}
	return m.openInstalled(value)
}

func (m *Module) hostRequire(c *gin.Context) (Installation, bool) {
	installation, err := m.hostInstallation(c.Param("id"))
	if err != nil {
		pkg.Fail(c, 409, err.Error())
		return Installation{}, false
	}
	return installation, true
}

func (m *Module) hostList(c *gin.Context) {
	list := []hostSpec{}
	for _, item := range m.hostInstallations() {
		spec := item.Manifest.hostSpec()
		spec.Commands = nonNil(spec.Commands)
		spec.Views = nonNil(spec.Views)
		spec.Settings = nonNil(spec.Settings)
		spec.Tools = nonNil(spec.Tools)
		list = append(list, spec)
	}
	pkg.OK(c, list)
}

func nonNil[T any](items []T) []T {
	if items == nil {
		return []T{}
	}
	return items
}

// StartHost 在应用启动时拉起已声明常驻服务的插件后台进程。
func (m *Module) StartHost() {
	for _, item := range m.hostInstallations() {
		if len(item.Manifest.hostSpec().Services) > 0 {
			go m.RefreshHost(item.Manifest.ID)
		}
	}
}

// RefreshHost 在注册表更新提交后同步运行状态：撤销或替换版本时停止旧进程，
// 仅在用户显式授予执行权限时启动插件声明的常驻服务。
func (m *Module) RefreshHost(id string) {
	if m.host == nil {
		return
	}
	item, err := m.hostInstallation(id)
	m.host.mu.Lock()
	old := m.host.workers[id]
	if old != nil && (err != nil || old.installation.Root != item.Root) {
		delete(m.host.workers, id)
	}
	m.host.mu.Unlock()
	if old != nil && (err != nil || old.installation.Root != item.Root) {
		func() {
			ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
			defer cancel()
			_, _ = old.call(ctx, hostRequest{Operation: "shutdown"})
			old.terminate()
		}()
	}
	if err == nil && len(item.Manifest.hostSpec().Services) > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		defer cancel()
		_, _ = m.hostWorker(ctx, item)
	}
}

// CloseHost 在应用退出时通知所有 worker 关闭并回收进程，避免残留子进程。
func (m *Module) CloseHost() {
	if m.host == nil {
		return
	}
	m.host.mu.Lock()
	m.host.closed = true
	workers := m.host.workers
	m.host.workers = make(map[string]*hostedWorker)
	m.host.mu.Unlock()
	var group sync.WaitGroup
	for _, worker := range workers {
		group.Go(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
			defer cancel()
			_, _ = worker.call(ctx, hostRequest{Operation: "shutdown"})
			worker.terminate()
		})
	}
	group.Wait()
}

// hostWorker 按插件目录复用已启动的独立进程，并在清单根目录变化时替换旧实例。
// 同时限制全局进程数量，防止大量插件耗尽系统资源。
func (m *Module) hostWorker(ctx context.Context, item Installation) (*hostedWorker, error) {
	h := m.host
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, errors.New("插件宿主已关闭")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	current, err := m.hostInstallation(item.Manifest.ID)
	if err != nil || current.Root != item.Root {
		return nil, errors.New("插件状态或版本已改变")
	}
	for id, worker := range h.workers {
		select {
		case <-worker.done:
			delete(h.workers, id)
		default:
		}
	}
	if worker := h.workers[item.Manifest.ID]; worker != nil {
		if worker.installation.Root == item.Root {
			return worker, nil
		}
		worker.terminate()
		delete(h.workers, item.Manifest.ID)
	}
	if len(h.workers) >= 12 {
		return nil, errors.New("插件运行实例已达上限，请停用不需要的插件")
	}
	entry, err := readHostEntry(item.Root, item.Manifest.Main, 768<<10)
	if err != nil {
		return nil, err
	}
	h.dataMu.Lock()
	values := m.readHostData(item)
	h.dataMu.Unlock()
	settings, _ := json.Marshal(values.Settings)
	storage, _ := json.Marshal(values.Storage)
	worker, err := spawnHostWorker(h.executable, item, func(worker *hostedWorker, response hostResponse) {
		if response.Completion != nil {
			go func() {
				value := m.completeForWorker(worker, *response.Completion)
				raw, _ := json.Marshal(value)
				_ = worker.write(hostRequest{Operation: "completion", ID: response.Completion.ID, Payload: raw})
			}()
			return
		}
		// 异步效果通过独立 goroutine 路由，扫描器必须继续读取命令回复，避免阻塞消息通道。
		select {
		case h.dispatch <- struct{}{}:
			go func() {
				defer func() { <-h.dispatch }()
				items := m.applyHostEffects(context.Background(), item, response.Events, 0)
				h.mu.Lock()
				defer h.mu.Unlock()
				for _, event := range items {
					if len(h.async) >= 48 {
						h.async = h.async[1:]
					}
					h.async = append(h.async, hostNotification{PluginID: item.Manifest.ID, hostEvent: event})
				}
			}()
		default:
		}
	})
	if err != nil {
		return nil, errors.New("无法启动独立插件进程")
	}
	load := &hostWorkerLoad{
		Source: string(entry), Main: item.Manifest.Main, Modules: packageModules(item), Spec: item.Manifest.hostSpec(),
		Manifest: item.Manifest, Settings: settings, Storage: storage,
	}
	if h.model != nil && slices.Contains(item.Manifest.Permissions, "models.list") {
		if model, err := h.model(); err == nil && model.Key != "" {
			model.IsDefault = true
			load.Models = []HostCompletionModel{model}
		}
	}
	first, err := worker.call(ctx, hostRequest{Operation: "load", Load: load})
	if err != nil || first.Error != "" {
		worker.terminate()
		if first.Error != "" {
			return nil, errors.New(first.Error)
		}
		return nil, errors.New("加载插件执行入口超时")
	}
	h.workers[item.Manifest.ID] = worker
	// 启动阶段的事件可能继续调用其他插件，放到锁外异步路由以免死锁。
	if len(first.Events) > 0 {
		go m.applyHostEffects(context.Background(), item, first.Events, 0)
	}
	return worker, nil
}

// readHostEntry 通过 os.Root 读取插件目录内的文件，把路径限制在安装根目录内。
func readHostEntry(root, name string, max int64) ([]byte, error) {
	local, err := packagePath(name)
	if err != nil {
		return nil, err
	}
	dir, err := os.OpenRoot(root)
	if err != nil {
		return nil, errors.New("插件目录不可用")
	}
	defer dir.Close()
	file, err := dir.Open(local)
	if err != nil {
		return nil, errors.New("插件入口不可用")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("插件入口不是普通文件")
	}
	return readLimited(file, max)
}

func (m *Module) hostDataPath() string  { return filepath.Join(m.root, "host-data") }
func hostDataFilename(id string) string { return "plugin." + id + ".json" }
func (m *Module) writeHostData(id string, value hostData) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(raw) > 2*workerDataLimit+100 {
		return errors.New("插件数据超出大小限制")
	}
	return atomicWrite(m.hostDataPath(), hostDataFilename(id), raw)
}

func (m *Module) readHostData(item Installation) hostData {
	value := hostData{Settings: map[string]json.RawMessage{}, Storage: map[string]json.RawMessage{}}
	file, err := os.Open(filepath.Join(m.hostDataPath(), hostDataFilename(item.Manifest.ID)))
	if err == nil {
		defer file.Close()
		raw, err := readLimited(file, 2*workerDataLimit+100)
		if err == nil {
			_ = json.Unmarshal(raw, &value)
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return value
	}
	settings := make(map[string]json.RawMessage)
	for _, definition := range item.Manifest.hostSpec().Settings {
		if raw := value.Settings[definition.Key]; validHostSetting(definition, raw) {
			settings[definition.Key] = raw
		} else if validHostSetting(definition, definition.Default) {
			settings[definition.Key] = definition.Default
		}
	}
	value.Settings = settings
	if value.Storage == nil {
		value.Storage = map[string]json.RawMessage{}
	}
	return value
}

// validHostSetting 按清单声明的类型校验设置值，拒绝越权写入未声明字段或超大值。
func validHostSetting(field hostSetting, value json.RawMessage) bool {
	if len(value) == 0 || len(value) > 16<<10 {
		return false
	}
	var decoded any
	if json.Unmarshal(value, &decoded) != nil {
		return false
	}
	switch field.Type {
	case "string", "textarea", "password":
		_, ok := decoded.(string)
		return ok
	case "boolean":
		_, ok := decoded.(bool)
		return ok
	case "number", "integer":
		n, ok := decoded.(float64)
		return ok && (field.Type != "integer" || n == math.Trunc(n))
	case "select", "enum":
		var options []json.RawMessage
		if json.Unmarshal(field.Options, &options) != nil {
			return false
		}
		for _, option := range options {
			var data struct{ Value json.RawMessage }
			if json.Unmarshal(option, &data) != nil || len(data.Value) == 0 {
				data.Value = option
			}
			var candidate any
			_ = json.Unmarshal(data.Value, &candidate)
			switch v := decoded.(type) {
			case string:
				if c, ok := candidate.(string); ok && c == v {
					return true
				}
			case bool:
				if c, ok := candidate.(bool); ok && c == v {
					return true
				}
			case float64:
				if c, ok := candidate.(float64); ok && c == v {
					return true
				}
			}
		}
	}
	return false
}

// storeHostSettings 合并并持久化设置，只接受清单中已声明且类型匹配的字段。
func (m *Module) storeHostSettings(item Installation, update map[string]json.RawMessage) (map[string]json.RawMessage, error) {
	if len(update) == 0 {
		return nil, errors.New("请提供要保存的插件设置")
	}
	m.host.dataMu.Lock()
	defer m.host.dataMu.Unlock()
	data := m.readHostData(item)
	spec := item.Manifest.hostSpec()
	for key, raw := range update {
		index := slices.IndexFunc(spec.Settings, func(field hostSetting) bool { return field.Key == key })
		if index < 0 || !validHostSetting(spec.Settings[index], raw) {
			return nil, errors.New("插件设置值或字段无效")
		}
		data.Settings[key] = raw
	}
	if err := m.writeHostData(item.Manifest.ID, data); err != nil {
		return nil, errors.New("无法保存插件设置或设置过大")
	}
	return data.Settings, nil
}

func (m *Module) hostSettings(c *gin.Context) {
	item, ok := m.hostRequire(c)
	if !ok {
		return
	}
	m.host.dataMu.Lock()
	settings := m.readHostData(item).Settings
	m.host.dataMu.Unlock()
	pkg.OK(c, settings)
}

func (m *Module) updateHostSettings(c *gin.Context) {
	item, ok := m.hostRequire(c)
	if !ok {
		return
	}
	var update map[string]json.RawMessage
	if c.ShouldBindJSON(&update) != nil {
		pkg.Fail(c, 400, "插件设置格式无效")
		return
	}
	settings, err := m.storeHostSettings(item, update)
	if err != nil {
		pkg.Fail(c, 400, err.Error())
		return
	}
	m.syncHostSettings(c.Request.Context(), item, settings)
	pkg.OK(c, settings)
}

// syncHostSettings 重启进程让新设置生效：上游插件可能在 onLoad 时缓存了 getSettings()。
func (m *Module) syncHostSettings(ctx context.Context, item Installation, settings map[string]json.RawMessage) {
	m.host.mu.Lock()
	worker := m.host.workers[item.Manifest.ID]
	if worker != nil && worker.installation.Root == item.Root {
		// 上游插件可能在 onLoad 时缓存 getSettings()，因此先摘除旧实例再重启。
		delete(m.host.workers, item.Manifest.ID)
	}
	m.host.mu.Unlock()
	if worker != nil && worker.installation.Root == item.Root {
		raw, _ := json.Marshal(settings)
		_, _ = worker.call(ctx, hostRequest{Operation: "settings", Payload: raw})
		_, _ = worker.call(ctx, hostRequest{Operation: "shutdown"})
		worker.terminate()
		go m.RefreshHost(item.Manifest.ID)
	}
}

func (m *Module) hostCommand(c *gin.Context) {
	item, ok := m.hostRequire(c)
	if !ok {
		return
	}
	var input struct {
		ID      string               `json:"id"`
		Context HostWorkspaceContext `json:"context"`
	}
	if c.ShouldBindJSON(&input) != nil || !slices.ContainsFunc(item.Manifest.hostSpec().Commands, func(cmd hostCommand) bool {
		return cmd.ID == input.ID
	}) {
		pkg.Fail(c, 400, "请选择插件已声明的命令")
		return
	}
	ctx := WithHostWorkspace(c.Request.Context(), input.Context)
	result, err := m.executeHost(ctx, item, hostRequest{Operation: "command", ID: input.ID}, 0)
	if err != nil {
		pkg.Fail(c, 409, err.Error())
		return
	}
	pkg.OK(c, result)
}

// executeHost 统一执行一次宿主调用，并在返回前把事件路由给其他插件。
// 调用参数与结果共享消息通道，因此这里先拦截超限负载，避免撑大管道。
func (m *Module) executeHost(ctx context.Context, item Installation, request hostRequest, depth int) (hostResponse, error) {
	if len(request.Payload) > workerDataLimit {
		return hostResponse{}, errors.New("插件调用参数超出大小限制")
	}
	worker, err := m.hostWorker(ctx, item)
	if err != nil {
		return hostResponse{}, err
	}
	result, err := worker.call(ctx, request)
	if err != nil {
		return hostResponse{}, err
	}
	result.Events = m.applyHostEffects(ctx, item, result.Events, depth)
	if result.Error != "" {
		return result, errors.New(result.Error)
	}
	return result, nil
}

func (m *Module) hostEvents(c *gin.Context) {
	out := []hostNotification{}
	if m.hostAvailable() {
		m.host.mu.Lock()
		out = append(out, m.host.async...)
		m.host.async = nil
		m.host.mu.Unlock()
	}
	pkg.OK(c, out)
}

func clipHostText(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	runes := []rune(text)
	return string(runes[:limit])
}
