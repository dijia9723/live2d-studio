// trusted_extension.go 负责可信 Pi 扩展的摘要校验、桌面授权与每轮运行的快照隔离。
package piplugins

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"server/internal/pkg"

	"github.com/gin-gonic/gin"
)

// 可信扩展会以代码形式交给外部代理执行，因此入口数、单轮总大小与单次运行数量的上限
// 都必须写死在宿主侧，不能由插件自行放宽。
const (
	trustedExtensionPermission = "agent.extension"
	trustedExtensionCapability = "agentExtensions"
	maxTrustedExtensionEntries = 8
	maxTrustedExtensionsPerRun = 64
	maxTrustedBytesPerRun      = 512 << 20
)

// trustedExtensionGrant 绑定插件版本、安装目录与内容摘要，任一变化即视为需要重新授权。
type trustedExtensionGrant struct {
	Version   string `json:"version"`
	Directory string `json:"directory"`
	Digest    string `json:"digest"`
}

// trustedExtensionStatus 返回给前端用于展示入口、内容是否完整以及是否已获授权。
type trustedExtensionStatus struct {
	Version  string   `json:"version"`
	Entries  []string `json:"entries"`
	Ready    bool     `json:"ready"`
	Approved bool     `json:"approved"`
}

// trustedExtensionPaths 校验可信扩展声明：最多 8 个入口、必须声明 agent.extension 权限、
// 路径合法且扩展名为 TypeScript 或 JavaScript。
func (m Manifest) trustedExtensionPaths() ([]string, error) {
	var contributions struct {
		Entries []string `json:"agentExtensions"`
	}
	if len(m.Contributes) == 0 {
		return nil, nil
	}
	if err := json.Unmarshal(m.Contributes, &contributions); err != nil {
		return nil, errors.New("插件扩展声明无效")
	}
	entries := contributions.Entries
	if len(entries) == 0 {
		return nil, nil
	}
	if len(entries) > maxTrustedExtensionEntries || !slices.Contains(m.Permissions, trustedExtensionPermission) {
		return nil, errors.New("可信扩展最多允许 8 个入口，且需要 agent.extension 权限")
	}
	seen := make(map[string]bool, len(entries))
	for _, entry := range entries {
		if _, err := packagePath(entry); err != nil {
			return nil, err
		}
		switch extension(entry) {
		case ".ts", ".mts", ".js", ".mjs":
		default:
			return nil, errors.New("可信扩展入口必须是 TypeScript 或 JavaScript 文件")
		}
		key := strings.ToLower(entry)
		if seen[key] {
			return nil, errors.New("插件包含重复的可信扩展入口")
		}
		seen[key] = true
	}
	return entries, nil
}

// hashTrustedPackage 在读取同一次数据时完成哈希与复制：target 非空时把文件写入本轮快照，
// 目标端只有摘要与原始安装完全一致才会被后续启用，从而避免检查后到运行前被替换。
func hashTrustedPackage(ctx context.Context, source, target *os.Root) (string, int64, error) {
	digest := sha256.New()
	var bytesRead int64
	files := 0
	err := fs.WalkDir(source.FS(), ".", func(rel string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		path, err := packagePath(rel)
		if err != nil {
			return err
		}
		if entry.IsDir() {
			_, _ = fmt.Fprintf(digest, "d %d:%s\n", len(rel), rel)
			if target != nil {
				return target.Mkdir(path, 0700)
			}
			return nil
		}
		info, err := source.Lstat(path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() > maxExpandedSize-bytesRead || files >= maxEntries {
			return errors.New("可信扩展包含不支持的文件类型或超出大小限制")
		}
		files++
		mode := fs.FileMode(0600) | info.Mode().Perm()&0100
		_, _ = fmt.Fprintf(digest, "f %d:%s %d %d\n", len(rel), rel, info.Size(), mode)
		from, err := source.Open(path)
		if err != nil {
			return err
		}
		defer from.Close()
		stat, err := from.Stat()
		if err != nil || !os.SameFile(info, stat) {
			return errors.New("可信扩展在检查时发生变更")
		}
		var writer io.Writer = digest
		var to *os.File
		if target != nil {
			to, err = target.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_EXCL, mode)
			if err != nil {
				return err
			}
			writer = io.MultiWriter(digest, to)
		}
		n, copyErr := io.Copy(writer, io.LimitReader(from, info.Size()+1))
		if to != nil {
			copyErr = errors.Join(copyErr, to.Close())
		}
		if n != info.Size() || copyErr != nil {
			return errors.New("可信扩展在读取时发生变更")
		}
		bytesRead += n
		return nil
	})
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(digest.Sum(nil)), bytesRead, nil
}

// RegisterTrustedExtensions 挂载可信扩展的状态查询与授权接口。
func (m *Module) RegisterTrustedExtensions(g *gin.RouterGroup) {
	g.GET("/:id/trusted-extension", m.trustedExtensionDetails)
	g.PUT("/:id/trusted-extension", m.updateTrustedExtensionGrant)
}

// trustedDesktopRequest 要求请求来源必须是 Wails 桌面外壳的 Origin，
// 使普通浏览器页面无法为可执行扩展授权。
func (m *Module) trustedDesktopRequest(c *gin.Context) bool {
	if m.desktopAvailable == nil || !m.desktopAvailable() {
		return false
	}
	origin, err := url.Parse(c.GetHeader("Origin"))
	if err != nil || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
		return false
	}
	// The enclosing WorkspaceOnly group also verifies an optional Wails dev port.
	return origin.Scheme == "http" && origin.Hostname() == "wails.localhost" ||
		origin.Scheme == "wails" && origin.Host == "localhost"
}

// trustedGrantMatches 判定授权是否仍然有效：来源、版本、目录与摘要必须同时一致。
func trustedGrantMatches(record storedPlugin) bool {
	grant := record.ExtensionGrant
	return record.Source == "local" && grant != nil && record.ExtensionDigest != "" &&
		grant.Version == record.Version && grant.Directory == record.Directory && grant.Digest == record.ExtensionDigest
}

// trustedExtensionStatus 重新计算包摘要，判断内容是否仍完整，并给出是否具备有效授权。
func (m *Module) trustedExtensionStatus(ctx context.Context, record storedPlugin) (trustedExtensionStatus, error) {
	state := trustedExtensionStatus{Version: record.Version, Entries: []string{}}
	installed, err := m.openInstalled(record)
	if err != nil {
		return state, err
	}
	entries, err := installed.Manifest.trustedExtensionPaths()
	if err != nil || len(entries) == 0 {
		return state, err
	}
	state.Entries = entries
	if record.Source != "local" || record.ExtensionDigest == "" {
		return state, nil
	}
	root, err := os.OpenRoot(installed.Root)
	if err != nil {
		return state, err
	}
	defer root.Close()
	digest, _, err := hashTrustedPackage(ctx, root, nil)
	if err != nil {
		return state, err
	}
	state.Ready = digest == record.ExtensionDigest
	state.Approved = state.Ready && trustedGrantMatches(record)
	return state, nil
}

// trustedExtensionDetails 返回指定插件的可信扩展状态。
func (m *Module) trustedExtensionDetails(c *gin.Context) {
	m.mu.Lock()
	defer m.mu.Unlock()
	registry, err := m.readStorage()
	if err != nil {
		pkg.Fail(c, 500, "无法读取插件设置")
		return
	}
	record, exists := registry.Local[c.Param("id")]
	if !exists {
		pkg.Fail(c, 404, "找不到已安装的插件")
		return
	}
	state, err := m.trustedExtensionStatus(c.Request.Context(), record)
	if err != nil {
		pkg.Fail(c, 409, "无法验证可信扩展，请重新导入本地插件包")
		return
	}
	pkg.OK(c, state)
}

// updateTrustedExtensionGrant 授予或撤销可信扩展：仅桌面来源可授权，
// 且授权前要求插件内容摘要与安装记录一致。
func (m *Module) updateTrustedExtensionGrant(c *gin.Context) {
	var input struct {
		Approved *bool  `json:"approved"`
		Version  string `json:"version"`
	}
	if c.ShouldBindJSON(&input) != nil || input.Approved == nil || input.Version == "" {
		pkg.Fail(c, 400, "可信扩展授权参数无效")
		return
	}
	if *input.Approved && !m.trustedDesktopRequest(c) {
		pkg.Fail(c, 403, "请在 Studio 桌面客户端为可信扩展授权")
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	registry, err := m.readStorage()
	if err != nil {
		pkg.Fail(c, 500, "无法读取插件设置")
		return
	}
	id := c.Param("id")
	record, exists := registry.Local[id]
	if !exists || input.Version != record.Version {
		pkg.Fail(c, 409, "插件已变更，请刷新后重新确认")
		return
	}
	state, err := m.trustedExtensionStatus(c.Request.Context(), record)
	if *input.Approved && (err != nil || !state.Ready) {
		pkg.Fail(c, 409, "可信扩展需要未修改的本地插件包，请重新导入后授权")
		return
	}
	if *input.Approved {
		record.ExtensionGrant = &trustedExtensionGrant{
			Version: record.Version, Directory: record.Directory, Digest: record.ExtensionDigest,
		}
	} else {
		record.ExtensionGrant = nil
	}
	registry.Local[id] = record
	if err := m.writeStorage(registry); err != nil {
		pkg.Fail(c, 500, "无法保存可信扩展授权")
		return
	}
	state.Approved = *input.Approved
	pkg.OK(c, state)
}

// StageTrustedExtensions 把已授权且内容一致的本地扩展复制到本轮临时目录，返回可加载的入口路径。
// 只有 worker 退出后才能调用 cleanup；快照与安装目录解耦，因此运行期间升级插件不会影响当前一轮。
func (m *Module) StageTrustedExtensions(ctx context.Context) ([]string, func(), error) {
	noop := func() {}
	if m == nil || m.desktopAvailable == nil || !m.desktopAvailable() {
		return nil, noop, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	registry, err := m.readStorage()
	if err != nil {
		return nil, noop, err
	}
	var ids []string
	for id, record := range registry.Local {
		if record.Enabled && trustedGrantMatches(record) {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil, noop, nil
	}
	slices.Sort(ids)
	runDir, err := os.MkdirTemp("", "studio-pi-extensions-")
	if err != nil {
		return nil, noop, errors.New("无法准备可信扩展")
	}
	cleanup := func() { _ = os.RemoveAll(runDir) }
	var paths []string
	var bytesStaged int64
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			cleanup()
			return nil, noop, err
		}
		record := registry.Local[id]
		if record.ExtensionSize > maxTrustedBytesPerRun-bytesStaged {
			slog.Warn("可信扩展超出本轮容量", "plugin", id)
			continue
		}
		target := filepath.Join(runDir, record.Directory)
		stage, err := m.stageTrustedPackage(ctx, record, target)
		if err != nil || len(paths)+len(stage) > maxTrustedExtensionsPerRun {
			_ = os.RemoveAll(target)
			slog.Warn("跳过无法复核的可信扩展", "plugin", id)
			continue
		}
		paths = append(paths, stage...)
		bytesStaged += record.ExtensionSize
	}
	if len(paths) == 0 {
		cleanup()
		return nil, noop, ctx.Err()
	}
	return paths, cleanup, nil
}

// stageTrustedPackage 复制单个插件到快照目录，并核对摘要与大小都与安装时完全一致。
func (m *Module) stageTrustedPackage(ctx context.Context, record storedPlugin, target string) ([]string, error) {
	installed, err := m.openInstalled(record)
	if err != nil {
		return nil, err
	}
	entries, err := installed.Manifest.trustedExtensionPaths()
	if err != nil || len(entries) == 0 {
		return nil, errors.New("可信扩展入口无效")
	}
	source, err := os.OpenRoot(installed.Root)
	if err != nil {
		return nil, err
	}
	defer source.Close()
	if err := os.Mkdir(target, 0700); err != nil {
		return nil, err
	}
	destination, err := os.OpenRoot(target)
	if err != nil {
		return nil, err
	}
	defer destination.Close()
	digest, size, err := hashTrustedPackage(ctx, source, destination)
	if err != nil || digest != record.ExtensionDigest || size != record.ExtensionSize {
		return nil, errors.New("可信扩展与原始插件包内容不一致")
	}
	paths := make([]string, 0, len(entries))
	for _, entry := range entries {
		paths = append(paths, filepath.Join(target, filepath.FromSlash(entry)))
	}
	return paths, nil
}
