package webui

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/gin-gonic/gin"
)

//go:embed all:dist
var assets embed.FS

func Register(r *gin.Engine) {
	root, _ := fs.Sub(assets, "dist")
	server := http.FileServer(http.FS(root))
	r.NoRoute(func(c *gin.Context) {
		if c.Request.Method != "GET" && c.Request.Method != "HEAD" {
			c.Status(404)
			return
		}
		name := strings.TrimPrefix(path.Clean(c.Request.URL.Path), "/")
		if strings.HasPrefix(name, "api/") || strings.HasPrefix(name, "models/") {
			c.JSON(404, gin.H{"code": 404, "message": "接口不存在"})
			return
		}
		if name != "" && name != "." {
			if f, err := root.Open(name); err == nil {
				info, _ := f.Stat()
				f.Close()
				if info != nil && !info.IsDir() {
					server.ServeHTTP(c.Writer, c.Request)
					return
				}
			}
		}
		if path.Ext(name) != "" {
			c.Status(404)
			return
		}
		index, err := fs.ReadFile(root, "index.html")
		if err != nil {
			c.Data(503, "text/plain; charset=utf-8", []byte("请先在项目根目录运行 ./scripts/build.ps1 构建前端。"))
			return
		}
		c.Header("Cache-Control", "no-cache")
		c.Data(200, "text/html; charset=utf-8", index)
	})
}
