// Package character 管理 Live2D 角色的查询、修改与模型压缩包导入，
// 路由前缀为 /api/v1/characters。
package character

import (
	"errors"
	"net/http"
	"os"
	"strings"

	"server/internal/model"
	"server/internal/pkg"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// Module 注册角色路由并校验请求参数。
type Module struct{ Service *Service }

// Register 挂载角色列表、更新与模型导入接口。
func (m *Module) Register(r *gin.RouterGroup) {
	r.PUT("/characters/:id/action-names", func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20)
		var req ActionNamesRequest
		if c.ShouldBindJSON(&req) != nil || req.ModelPath == "" || req.Names == nil {
			pkg.Fail(c, 400, ErrActionNames.Error())
			return
		}
		saved, err := m.Service.SaveActionNames(c.Request.Context(), c.Param("id"), req)
		if err != nil {
			switch {
			case errors.Is(err, ErrActionNames):
				pkg.Fail(c, 400, ErrActionNames.Error())
			case errors.Is(err, ErrActions):
				pkg.Fail(c, 422, ErrActions.Error())
			default:
				pkg.Fail(c, 404, "角色不存在或命名保存失败")
			}
			return
		}
		pkg.OK(c, saved)
	})
	r.GET("/characters/:id/actions", func(c *gin.Context) {
		v, err := m.Service.Actions(c.Request.Context(), c.Param("id"))
		if err != nil {
			if errors.Is(err, ErrActions) {
				pkg.Fail(c, 422, ErrActions.Error())
			} else {
				pkg.Fail(c, 404, "角色不存在或动作读取失败")
			}
			return
		}
		pkg.OK(c, v)
	})
	r.GET("/characters", func(c *gin.Context) {
		v, err := m.Service.List()
		if err != nil {
			pkg.Fail(c, 500, "读取角色失败")
			return
		}
		pkg.OK(c, v)
	})
	r.PUT("/characters/:id", func(c *gin.Context) {
		var req model.Character
		if c.ShouldBindJSON(&req) != nil || strings.TrimSpace(req.Name) == "" || len(req.Name) > 100 || len(req.SystemPrompt) > 24000 {
			pkg.Fail(c, 400, "角色名称或提示词无效")
			return
		}
		v, err := m.Service.Update(c.Param("id"), req)
		if err != nil {
			pkg.Fail(c, 404, "角色不存在")
			return
		}
		pkg.OK(c, v)
	})
	r.POST("/characters/import", m.importModel)
	r.DELETE("/characters/:id", func(c *gin.Context) {
		if err := m.Service.Delete(c.Param("id")); err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				pkg.Fail(c, 404, "角色不存在")
			} else {
				pkg.Fail(c, 500, "删除角色失败")
			}
			return
		}
		pkg.OK(c, nil)
	})
}

// importModel 接收 multipart 上传的模型 ZIP，先落到临时文件再交给 Service 校验。
// 压缩包体积不设上限，临时文件在函数返回时删除，避免大文件常驻内存或残留磁盘。
func (m *Module) importModel(c *gin.Context) {
	f, err := c.FormFile("file")
	if err != nil {
		pkg.Fail(c, 400, "请选择模型 ZIP 文件")
		return
	}
	if c.Request.MultipartForm != nil {
		defer c.Request.MultipartForm.RemoveAll()
	}
	tmp, err := os.CreateTemp("", "studio-model-*.zip")
	if err != nil {
		pkg.Fail(c, 500, "创建临时文件失败")
		return
	}
	name := tmp.Name()
	tmp.Close()
	defer os.Remove(name)
	if err = c.SaveUploadedFile(f, name); err != nil {
		pkg.Fail(c, 400, "保存上传文件失败")
		return
	}
	v, err := m.Service.Import(name)
	if err != nil {
		pkg.Fail(c, 400, err.Error())
		return
	}
	pkg.OK(c, v)
}
