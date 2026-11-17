// Package memory 管理角色的长期记忆（增删改查与关键词检索），
// 路由前缀为 /api/v1/characters/:id/memories。
package memory

import (
	"errors"
	"net/http"

	"server/internal/pkg"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// Module 注册角色记忆路由并把 Service 错误映射为 HTTP 状态码。
type Module struct{ Service *Service }

// Register 挂载角色记忆的列表、创建、更新与删除接口。
func (m *Module) Register(r *gin.RouterGroup) {
	r.GET("/characters/:id/memories", m.list)
	r.POST("/characters/:id/memories", m.create)
	r.PUT("/characters/:id/memories/:memoryId", m.update)
	r.DELETE("/characters/:id/memories/:memoryId", m.remove)
}

func (m *Module) list(c *gin.Context) {
	memories, err := m.Service.List(c.Request.Context(), c.Param("id"))
	if err != nil {
		fail(c, err)
		return
	}
	pkg.OK(c, memories)
}

func (m *Module) create(c *gin.Context) {
	var req memoryRequest
	if c.ShouldBindJSON(&req) != nil {
		fail(c, ErrContent)
		return
	}
	memory, err := m.Service.Create(c.Request.Context(), c.Param("id"), req.Content)
	if err != nil {
		fail(c, err)
		return
	}
	pkg.OK(c, memory)
}

func (m *Module) update(c *gin.Context) {
	var req memoryRequest
	if c.ShouldBindJSON(&req) != nil {
		fail(c, ErrContent)
		return
	}
	memory, err := m.Service.Update(c.Request.Context(), c.Param("id"), c.Param("memoryId"), req.Content)
	if err != nil {
		fail(c, err)
		return
	}
	pkg.OK(c, memory)
}

func (m *Module) remove(c *gin.Context) {
	if err := m.Service.Delete(c.Request.Context(), c.Param("id"), c.Param("memoryId")); err != nil {
		fail(c, err)
		return
	}
	pkg.OK(c, nil)
}

type memoryRequest struct {
	Content string `json:"content"`
}

// fail 把领域错误映射为 400/404/409/500；未识别的错误统一隐藏细节，只返回通用提示。
func fail(c *gin.Context, err error) {
	switch {
	case errors.Is(err, ErrContent):
		pkg.Fail(c, http.StatusBadRequest, err.Error())
	case errors.Is(err, ErrLimit), errors.Is(err, ErrExists):
		pkg.Fail(c, http.StatusConflict, err.Error())
	case errors.Is(err, gorm.ErrRecordNotFound):
		pkg.Fail(c, http.StatusNotFound, "角色或记忆不存在")
	default:
		pkg.Fail(c, http.StatusInternalServerError, "记忆操作失败")
	}
}
