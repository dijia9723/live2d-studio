package character

import (
	"net/http"
	"os"
	"strings"

	"server/internal/model"
	"server/internal/pkg"

	"github.com/gin-gonic/gin"
)

type Module struct{ Service *Service }

func (m *Module) Register(r *gin.RouterGroup) {
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
}
func (m *Module) importModel(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 100<<20)
	f, err := c.FormFile("file")
	if err != nil {
		pkg.Fail(c, 400, "请选择不超过 100MB 的模型 ZIP 文件")
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
