// install.go 负责 .piplug 压缩包的解包、路径与大小校验以及插件安装记录落库。
package piplugins

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"server/internal/pkg"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const (
	// 同时限制压缩包大小、解压总量与条目数，防止压缩炸弹耗尽磁盘或内存。
	maxPackageSize  = 50 << 20
	maxExpandedSize = 256 << 20
	maxEntries      = 4096
)

// extract 先把所有条目路径规范化并统计解压总量，确认无误后才写盘。
// 预先校验可以让符号链接、大小写冲突和超限包在创建任何文件前被整体拒绝。
func extract(root *os.Root, archive []byte) error {
	entries, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil || len(entries.File) == 0 || len(entries.File) > maxEntries {
		return errors.New("插件不是有效的 .piplug ZIP 包")
	}
	type zipEntry struct {
		*zip.File
		local string
	}
	clean := make([]zipEntry, 0, len(entries.File))
	explicit := make(map[string]bool)
	canonical := make(map[string]string)
	remaining := uint64(maxExpandedSize)
	haveManifest := false
	for _, file := range entries.File {
		isDir := file.Mode().IsDir()
		if !isDir && !file.Mode().IsRegular() {
			return errors.New("插件包只能包含普通文件和目录")
		}
		name := strings.TrimSuffix(file.Name, "/")
		local, err := packagePath(name)
		key := strings.ToLower(name)
		if err != nil || explicit[key] || file.Flags&1 != 0 || file.UncompressedSize64 > remaining ||
			(isDir && file.UncompressedSize64 > 0) {
			return errors.New("插件包路径冲突、已加密或解压大小超限")
		}
		for subpath := name; subpath != ""; {
			lower := strings.ToLower(subpath)
			if old, exists := canonical[lower]; exists && old != subpath {
				return errors.New("插件包包含大小写冲突的目录")
			}
			canonical[lower] = subpath
			separator := strings.LastIndexByte(subpath, '/')
			if separator < 0 {
				break
			}
			subpath = subpath[:separator]
		}
		haveManifest = haveManifest || name == "manifest.json" && !isDir
		explicit[key] = true
		remaining -= file.UncompressedSize64
		clean = append(clean, zipEntry{File: file, local: local})
	}
	if !haveManifest {
		return errors.New("插件包根目录缺少 manifest.json")
	}
	for _, entry := range clean {
		if entry.Mode().IsDir() {
			if err := root.MkdirAll(entry.local, 0700); err != nil {
				return err
			}
			continue
		}
		if err := root.MkdirAll(filepath.Dir(entry.local), 0700); err != nil {
			return err
		}
		if err := extractFile(root, entry.local, entry.File); err != nil {
			return err
		}
	}
	return nil
}

// extractFile 以独占方式写入并核对实际字节数，声明大小与实际不符即视为可疑包。
func extractFile(root *os.Root, filename string, f *zip.File) error {
	from, err := f.Open()
	if err != nil {
		return err
	}
	defer from.Close()
	mode := 0600 | f.Mode().Perm()&0100
	to, err := root.OpenFile(filename, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	size, err := io.Copy(to, io.LimitReader(from, int64(f.UncompressedSize64)+1))
	if closeErr := to.Close(); err != nil || closeErr != nil {
		return errors.Join(err, closeErr)
	}
	if size != int64(f.UncompressedSize64) {
		return errors.New("插件包实际解压大小与声明不一致")
	}
	return nil
}

// install 在临时目录解包并校验清单，全部通过后才写入注册表。
// expectedID/expectedVersion 用于市场安装时绑定目录记录，避免下载到的包与所选版本不一致；
// 同时记录清单 SHA-256 与可信扩展摘要，供后续启动和授权时复核。
func (m *Module) install(archive []byte, source, expectedID, expectedVersion string) (Plugin, error) {
	if len(archive) == 0 || len(archive) > maxPackageSize {
		return Plugin{}, errors.New("插件包应小于 50 MiB")
	}
	directory := "package-" + uuid.NewString()
	dir := filepath.Join(m.root, directory)
	if err := os.MkdirAll(m.root, 0700); err != nil {
		return Plugin{}, err
	}
	if err := os.Mkdir(dir, 0700); err != nil {
		return Plugin{}, err
	}
	registered := false
	defer func() {
		if !registered {
			m.removePackage(directory)
		}
	}()
	root, err := os.OpenRoot(dir)
	if err != nil {
		return Plugin{}, err
	}
	defer root.Close()
	if err := extract(root, archive); err != nil {
		return Plugin{}, err
	}
	manifest, manifestBytes, err := readManifest(root)
	if err != nil {
		return Plugin{}, err
	}
	if expectedID != "" && (manifest.ID != expectedID || manifest.Version != expectedVersion) {
		return Plugin{}, errors.New("插件清单 ID 或版本与市场记录不符")
	}
	if _, builtin := bundledPlugin(manifest.ID); builtin {
		return Plugin{}, errors.New("插件包不能替换内置插件")
	}
	now := time.Now().UTC()
	plugin := manifest.plugin()
	plugin.Source = source
	plugin.InstalledAt = &now
	hash := sha256.Sum256(manifestBytes)
	record := storedPlugin{Plugin: plugin, Directory: directory, ManifestHash: hex.EncodeToString(hash[:])}
	if entries, err := manifest.trustedExtensionPaths(); err != nil {
		return Plugin{}, err
	} else if len(entries) > 0 {
		if source != "local" {
			return Plugin{}, errors.New("可信 Pi 扩展只允许导入本地插件包")
		}
		record.ExtensionDigest, record.ExtensionSize, err = hashTrustedPackage(context.Background(), root, nil)
		if err != nil {
			return Plugin{}, errors.New("无法记录可信扩展插件包的校验信息")
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s, err := m.readStorage()
	if err != nil {
		return Plugin{}, err
	}
	old := s.Local[plugin.ID]
	s.Local[plugin.ID] = record
	if err := m.writeStorage(s); err != nil {
		return Plugin{}, err
	}
	registered = true
	m.removePackage(old.Directory)
	go m.RefreshHost(plugin.ID)
	return plugin, nil
}

// importPlugin 处理本地导入：先用 MaxBytesReader 限制请求体，再校验扩展名与文件大小。
func (m *Module) importPlugin(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxPackageSize+(1<<20))
	header, err := c.FormFile("file")
	if c.Request.MultipartForm != nil {
		defer c.Request.MultipartForm.RemoveAll()
	}
	if err != nil || header.Size > maxPackageSize || extension(header.Filename) != ".piplug" {
		pkg.Fail(c, 400, "请选择小于 50 MiB 的 .piplug 插件包")
		return
	}
	file, err := header.Open()
	if err != nil {
		pkg.Fail(c, 400, "无法读取插件包")
		return
	}
	defer file.Close()
	archive, err := readLimited(file, maxPackageSize)
	if err != nil {
		pkg.Fail(c, 400, "无法读取插件包或大小超限")
		return
	}
	plugin, err := m.install(archive, "local", "", "")
	if err != nil {
		pkg.Fail(c, 400, err.Error())
		return
	}
	pkg.OK(c, plugin)
}
