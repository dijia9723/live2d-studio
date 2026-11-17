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

func (m *Module) list(c *gin.Context) {
	assets, err := m.Service.List(c.Request.Context())
	if err != nil {
		pkg.Fail(c, 500, "读取背景素材失败")
		return
	}
	pkg.OK(c, assets)
}

func (m *Module) upload(c *gin.Context) {
	// Stream directly to a bounded temporary file instead of buffering a large
	// video in memory or relying on the untrusted multipart Content-Type.
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
	// ServeContent handles HEAD and single/multipart byte ranges for seeking.
	http.ServeContent(c.Writer, c.Request, asset.Filename, info.ModTime(), f)
}
