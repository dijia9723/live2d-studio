package coding

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"server/internal/pkg"

	"github.com/gin-gonic/gin"
)

func (m *Module) requireBuiltin(c *gin.Context, id string) bool {
	if m.PluginEnabled == nil || !m.PluginEnabled(id) {
		pkg.Fail(c, 409, "请在插件中心启用此插件")
		return false
	}
	return true
}

func (m *Module) fileAction(c *gin.Context) {
	if !m.requireBuiltin(c, "pi.file-manager") {
		return
	}
	root := m.openProject(c, c.Param("project"))
	if root == nil {
		return
	}
	defer root.Close()
	var input struct {
		Action string `json:"action"`
		Path   string `json:"path"`
		Target string `json:"target"`
	}
	if c.ShouldBindJSON(&input) != nil {
		pkg.Fail(c, 400, "文件操作参数无效")
		return
	}
	local, err := localPath(input.Path, false)
	if err == nil {
		err = checkFilePath(root, local)
	}
	if err != nil {
		pkg.Fail(c, 400, err.Error())
		return
	}
	if input.Action == "file" {
		_, err = m.writeFile(root, input.Path, fileContent{})
	} else {
		err = m.changeFileEntry(root, input.Action, local, input.Target)
	}
	switch {
	case errors.Is(err, fs.ErrExist) || errors.Is(err, errStaleFile):
		pkg.Fail(c, 409, "目标已存在")
	case err != nil:
		pkg.Fail(c, 400, err.Error())
	default:
		pkg.OK(c, nil)
	}
}

func (m *Module) changeFileEntry(root *os.Root, action, local, target string) error {
	m.filesMu.Lock()
	defer m.filesMu.Unlock()
	if err := checkFilePath(root, local); err != nil {
		return err
	}
	switch action {
	case "directory":
		return root.Mkdir(local, 0755)
	case "remove":
		if err := root.Remove(local); err != nil {
			return errors.New("无法删除此条目，请确认目录为空或文件未被占用")
		}
		return nil
	case "move":
		next, err := localPath(target, false)
		if err != nil {
			return err
		}
		if err := checkFilePath(root, next); err != nil {
			return err
		}
		if _, err := root.Lstat(next); !errors.Is(err, fs.ErrNotExist) {
			return fs.ErrExist
		}
		return root.Rename(local, next)
	default:
		return errors.New("未知的文件操作")
	}
}

var previewContentTypes = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".webp": "image/webp", ".avif": "image/avif",
	".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac",
	".m4a": "audio/mp4", ".mp4": "video/mp4", ".webm": "video/webm", ".pdf": "application/pdf",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
}

func (m *Module) mediaPreview(c *gin.Context) {
	if !m.requireBuiltin(c, "pi.file-manager") {
		return
	}
	root := m.openProject(c, c.Param("project"))
	if root == nil {
		return
	}
	defer root.Close()
	local, err := localPath(c.Query("path"), false)
	contentType := previewContentTypes[strings.ToLower(filepath.Ext(local))]
	if err != nil || contentType == "" || checkFilePath(root, local) != nil {
		pkg.Fail(c, 400, "此文件类型不支持预览")
		return
	}
	info, err := root.Stat(local)
	size, label := int64(24<<20), "24 MiB"
	if extension := strings.ToLower(filepath.Ext(local)); extension == ".xlsx" || extension == ".xlsm" {
		size, label = 8<<20, "8 MiB"
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > size {
		pkg.Fail(c, 400, "预览需要不超过 "+label+" 的普通文件")
		return
	}
	file, err := root.Open(local)
	if err != nil {
		pkg.Fail(c, 400, "无法打开预览文件")
		return
	}
	defer file.Close()
	c.Header("Content-Type", contentType)
	c.Header("Content-Security-Policy", "sandbox; default-src 'none'")
	http.ServeContent(c.Writer, c.Request, info.Name(), info.ModTime(), file)
}
