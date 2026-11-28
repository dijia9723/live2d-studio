package settings

import (
	"log/slog"
	"path/filepath"
	"sync"

	"server/internal/config"
	"server/internal/middleware"
	"server/internal/modules/desktop"
	"server/internal/pkg"

	"github.com/gin-gonic/gin"
)

// Storage exposes the current data directory and the desktop startup preference.
type Storage struct {
	Config  config.Config
	Desktop *desktop.Module
	pickMu  sync.Mutex
}

func (s *Storage) Register(r *gin.RouterGroup) {
	group := r.Group("/settings/storage", middleware.WorkspaceOnly(s.Desktop.Available))
	group.GET("", s.status)
	group.POST("", s.choose)
}

func (s *Storage) status(c *gin.Context) {
	current, err := filepath.Abs(s.Config.DataDir)
	if err != nil {
		pkg.Fail(c, 500, "无法解析当前数据目录")
		return
	}
	next, err := s.Config.PreferredDataDir()
	if err != nil {
		pkg.Fail(c, 500, err.Error())
		return
	}
	if next == "" {
		next = current
	}
	pkg.OK(c, gin.H{
		"current_directory":    current,
		"next_directory":       next,
		"can_choose":           s.Config.DataDirEditable() && s.Desktop.Available(),
		"environment_override": s.Config.DataDirFromEnv(),
	})
}

func (s *Storage) choose(c *gin.Context) {
	if s.Config.DataDirFromEnv() {
		pkg.Fail(c, 409, "数据目录由 STUDIO_DATA_DIR 环境变量指定")
		return
	}
	if !s.Config.DataDirEditable() || !s.Desktop.Available() {
		pkg.Fail(c, 409, "请在桌面客户端更改数据目录")
		return
	}
	if !s.pickMu.TryLock() {
		pkg.Fail(c, 409, "数据目录选择器已打开")
		return
	}
	defer s.pickMu.Unlock()

	dir, err := s.Desktop.PickDirectory("选择下次启动使用的数据目录", s.Config.DataDir)
	if err != nil {
		slog.Error("打开数据目录选择器失败", "error", err)
		pkg.Fail(c, 500, "打开目录选择器失败")
		return
	}
	if dir != "" {
		if err := s.Config.SaveDataDir(dir); err != nil {
			pkg.Fail(c, 500, err.Error())
			return
		}
	}
	s.status(c)
}
