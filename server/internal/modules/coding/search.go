package coding

import (
	"errors"
	"io/fs"
	"strings"
	"unicode/utf8"

	"server/internal/pkg"

	"github.com/gin-gonic/gin"
)

var errSearchLimit = errors.New("搜索已达到上限")

func (m *Module) search(c *gin.Context) {
	query := strings.ToLower(strings.TrimSpace(c.Query("q")))
	if query == "" || utf8.RuneCountInString(query) > 128 {
		pkg.Fail(c, 400, "请输入 1–128 字的文件名或路径")
		return
	}
	root := m.openProject(c, c.Param("project"))
	if root == nil {
		return
	}
	defer root.Close()
	ctx := c.Request.Context()
	matches := make([]string, 0, 30)
	visited := 0
	err := fs.WalkDir(root.FS(), ".", func(path string, entry fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			if path == "." {
				return err
			}
			return nil
		}
		visited++
		if visited > 25000 {
			return errSearchLimit
		}
		if path == "." {
			return nil
		}
		if ignoredName(strings.TrimRight(entry.Name(), " .")) || strings.HasPrefix(entry.Name(), ".studio-pi-") {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if entry.Type().IsRegular() && strings.Contains(strings.ToLower(path), query) {
			if len(matches) == 30 {
				return errSearchLimit
			}
			matches = append(matches, path)
		}
		return nil
	})
	if ctx.Err() != nil {
		return
	}
	truncated := errors.Is(err, errSearchLimit)
	if err != nil && !truncated {
		pkg.Fail(c, 500, "搜索项目文件失败")
		return
	}
	pkg.OK(c, gin.H{"files": matches, "truncated": truncated})
}
