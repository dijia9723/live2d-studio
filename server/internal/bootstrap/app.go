package bootstrap

import (
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"server/internal/config"
	"server/internal/middleware"
	"server/internal/migrate"
	"server/internal/modules/agent"
	"server/internal/modules/character"
	"server/internal/modules/conversation"
	"server/internal/modules/desktop"
	"server/internal/modules/sceneassets"
	"server/internal/modules/settings"
	"server/internal/modules/speech"
	"server/internal/pkg"
	"server/internal/router"
	"server/internal/webui"
)

type App struct {
	Router  *gin.Engine
	Desktop *desktop.Module
	DB      *gorm.DB
	Config  config.Config
}

func New(cfg config.Config) (*App, error) {
	if err := os.MkdirAll(cfg.DataDir, 0700); err != nil {
		return nil, err
	}
	db, err := gorm.Open(sqlite.Open(filepath.Join(cfg.DataDir, "studio.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		return nil, err
	}
	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(1)
	for _, pragma := range []string{"PRAGMA journal_mode = WAL", "PRAGMA busy_timeout = 5000", "PRAGMA foreign_keys = ON"} {
		if err = db.Exec(pragma).Error; err != nil {
			sqlDB.Close()
			return nil, err
		}
	}
	if err = migrate.Run(db); err != nil {
		sqlDB.Close()
		return nil, err
	}
	modelsDir := filepath.Join(cfg.DataDir, "models")
	if err = os.MkdirAll(modelsDir, 0700); err != nil {
		sqlDB.Close()
		return nil, err
	}
	mediaDir := filepath.Join(cfg.DataDir, "scene-media")
	if err = os.MkdirAll(mediaDir, 0700); err != nil {
		sqlDB.Close()
		return nil, err
	}
	ss := settings.New(db, cfg)
	cs := &character.Service{DB: db, ModelsDir: modelsDir}
	ds := &desktop.Module{}
	assets := &sceneassets.Module{Service: &sceneassets.Service{DB: db, MediaDir: mediaDir}}
	conversations := &conversation.Service{DB: db, Characters: cs, Settings: ss, Agent: &agent.Service{}}
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery(), middleware.LocalOnly(ds.Available))
	r.Use(func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			c.Header("Cache-Control", "no-store")
			if c.Request.Method != "GET" && c.Request.URL.Path != "/api/v1/characters/import" && c.Request.URL.Path != "/api/v1/scene-assets" {
				c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 26<<20)
			}
		}
		c.Next()
	})
	r.GET("/api/v1/health", func(c *gin.Context) { pkg.OK(c, gin.H{"status": "ok", "version": "0.1.0", "agent": "eino"}) })
	router.Register(r, &character.Module{Service: cs}, &settings.Module{Service: ss}, &conversation.Module{Service: conversations}, &speech.Module{Settings: ss}, ds, assets)
	assets.RegisterMedia(r)
	r.GET("/models/*path", func(c *gin.Context) {
		rel := filepath.Clean(filepath.FromSlash(strings.TrimPrefix(c.Param("path"), "/")))
		if rel == "." || filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			c.Status(404)
			return
		}
		target := filepath.Join(modelsDir, rel)
		info, err := os.Stat(target)
		if err != nil || info.IsDir() {
			c.Status(404)
			return
		}
		c.File(target)
	})
	webui.Register(r)
	return &App{Router: r, Desktop: ds, DB: db, Config: cfg}, nil
}
func (a *App) Listen() (*http.Server, net.Listener, error) {
	listener, err := net.Listen("tcp", fmt.Sprintf("%s:%d", a.Config.Host, a.Config.Port))
	if err != nil {
		return nil, nil, err
	}
	server := &http.Server{Handler: a.Router, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			slog.Error("HTTP 服务退出", "error", err)
		}
	}()
	return server, listener, nil
}
func (a *App) Close() {
	db, err := a.DB.DB()
	if err == nil {
		_ = db.Close()
	}
}
