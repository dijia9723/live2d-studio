// 本文件实现素材列表、流式上传、删除与媒体读取的 HTTP 处理。

package sceneassets

import (
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"server/internal/pkg"
)

// list 按创建时间倒序返回全部背景素材，并补全可访问的 URL。
func (m *Module) list(c *gin.Context) {
	assets, err := m.Service.List(c.Request.Context())
	if err != nil {
		pkg.Fail(c, 500, "读取背景素材失败")
		return
	}
	pkg.OK(c, assets)
}

// upload 以流式方式解析 multipart，只处理表单字段 file，并把内容直接写入受限的临时文件，
// 避免大视频常驻内存；实际类型由文件头嗅探而非客户端声明的 Content-Type 决定。
// 其它字段会被丢弃，但同样受 MaxBytesReader 的总量限制。
func (m *Module) upload(c *gin.Context) {
	// 请求体上限比服务层限制多留 1MB，容纳 multipart 边界与其它表单字段。
	if c.Request.ContentLength > VideoLimit+(1<<20) {
		pkg.Fail(c, 413, ErrTooLarge.Error())
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, VideoLimit+(1<<20))
	reader, err := c.Request.MultipartReader()
	if err != nil {
		pkg.Fail(c, 400, "请使用 multipart/form-data 上传 file 文件")
		return
	}
	for {
		part, readErr := reader.NextPart()
		if readErr != nil {
			var max *http.MaxBytesError
			if errors.As(readErr, &max) {
				pkg.Fail(c, 413, ErrTooLarge.Error())
			} else {
				pkg.Fail(c, 400, "请选择要上传的背景图片或视频")
			}
			return
		}
		if part.FormName() != "file" || part.FileName() == "" {
			_, discardErr := io.Copy(io.Discard, part)
			_ = part.Close()
			if discardErr != nil {
				pkg.Fail(c, 413, ErrTooLarge.Error())
				return
			}
			continue
		}
		asset, createErr := m.Service.Create(c.Request.Context(), part.FileName(), part)
		_ = part.Close()
		if createErr != nil {
			var max *http.MaxBytesError
			switch {
			case errors.Is(createErr, ErrUnsupported):
				pkg.Fail(c, 400, createErr.Error())
			case errors.Is(createErr, ErrTooLarge), errors.As(createErr, &max):
				pkg.Fail(c, 413, ErrTooLarge.Error())
			case errors.Is(createErr, io.ErrUnexpectedEOF):
				pkg.Fail(c, 400, "文件上传不完整，请重试")
			default:
				pkg.Fail(c, 500, "保存背景素材失败，请检查磁盘空间后重试")
			}
			return
		}
		pkg.OK(c, asset)
		return
	}
}

// remove 删除素材记录与磁盘文件，记录不存在时返回 404。
func (m *Module) remove(c *gin.Context) {
	err := m.Service.Delete(c.Request.Context(), c.Param("id"))
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			pkg.Fail(c, 404, "背景素材不存在")
		} else {
			pkg.Fail(c, 500, "删除背景素材失败")
		}
		return
	}
	pkg.OK(c, nil)
}

// media 使用 http.ServeContent 输出媒体文件，自动支持 HEAD 与单段/多段 Range 请求，
// 因此视频可以拖动进度条；文件名非法或记录不存在时统一返回 404。
func (m *Module) media(c *gin.Context) {
	filename := strings.TrimPrefix(c.Param("path"), "/")
	f, asset, err := m.Service.Open(c.Request.Context(), filename)
	if err != nil {
		c.Status(404)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		c.Status(404)
		return
	}
	c.Header("Content-Type", asset.MIMEType)
	c.Header("Cache-Control", "no-cache")
	// ServeContent 负责处理 HEAD 与单段/多段字节范围，从而支持视频拖动播放。
	http.ServeContent(c.Writer, c.Request, asset.Filename, info.ModTime(), f)
}
