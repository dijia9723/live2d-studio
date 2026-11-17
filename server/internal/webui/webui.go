// Package webui 把前端构建产物内嵌进二进制，并以 SPA 方式提供服务。
// dist 由前端构建脚本生成；缺失时返回提示而不是启动失败。
package webui

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/gin-gonic/gin"
)

// assets 内嵌构建后的前端资源；all: 前缀确保包含以 . 或 _ 开头的文件。
//
//go:embed all:dist
var assets embed.FS

// Register 注册前端静态资源与 SPA 路由回退。
//
// 已存在的静态文件直接返回；/api/ 与 /models/ 未命中返回 JSON 404；
// 带扩展名但文件不存在返回 404；其余无扩展名路径回退到 index.html，
// 交给前端路由处理。index.html 使用 no-cache，避免升级后仍加载旧页面。
func Register(r *gin.Engine) {
	root, _ := fs.Sub(assets, "dist")
	server := http.FileServer(http.FS(root))
	r.NoRoute(func(c *gin.Context) {
		// 非 GET/HEAD 的未匹配请求不做页面回退，直接 404。
		if c.Request.Method != "GET" && c.Request.Method != "HEAD" {
			c.Status(404)
			return
		}
		name := strings.TrimPrefix(path.Clean(c.Request.URL.Path), "/")
		// 接口与模型路径不参与 SPA 回退，避免前端路由吞掉真实 404。
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
		// 带扩展名说明请求的是具体文件，文件不存在就返回 404，而不是回退页面。
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
