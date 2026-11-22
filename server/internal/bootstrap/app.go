// Package bootstrap 负责后端服务的装配：准备数据目录、打开 SQLite、执行迁移、
// 创建业务服务实例并注册中间件与路由，是启动层与各业务模块之间的连接点。
package bootstrap

import (
	"context"
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
	"server/internal/modules/coding"
	"server/internal/modules/conversation"
	"server/internal/modules/desktop"
	"server/internal/modules/livemode"
	"server/internal/modules/memory"
	"server/internal/modules/piplugins"
	"server/internal/modules/sceneassets"
	"server/internal/modules/settings"
	"server/internal/modules/speech"
	"server/internal/pkg"
	"server/internal/router"
	"server/internal/tts"
	"server/internal/webui"
)

// App 持有装配完成的 HTTP 路由、桌面模块、数据库连接与生效配置。
// Router 由 Listen 包装成 http.Server；Desktop 供桌面构建登记窗口控制实现。
type App struct {
	Router       *gin.Engine
	Desktop      *desktop.Module
	DB           *gorm.DB
	Config       config.Config
	Live         *livemode.Service
	Terminal     *coding.TerminalService
	BrowserDebug *coding.BrowserDebugService
	Coding       *coding.Module
	Plugins      *piplugins.Module
}

// New 初始化数据库、迁移并装配所有业务模块。
//
// 装配顺序：数据目录 → SQLite 打开 → PRAGMA → 迁移 → 业务服务 →
// 中间件 → 路由注册 → 前端资源。任何一步失败都会关闭已打开的数据库连接，
// 避免留下半初始化状态。
func New(cfg config.Config) (*App, error) {
	// 数据目录含数据库与用户模型，权限收紧为仅当前用户可访问。
	if err := os.MkdirAll(cfg.DataDir, 0700); err != nil {
		return nil, err
	}
	// 使用纯 Go 的 SQLite 驱动，免 CGO 便于跨平台打包；日志静默以免刷屏。
	dbPath := filepath.Join(cfg.DataDir, "studio.db")
	_, statErr := os.Stat(dbPath)
	freshDatabase := os.IsNotExist(statErr)
	db, err := gorm.Open(sqlite.Open(dbPath), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		return nil, err
	}
	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}
	// SQLite 同一时刻只允许一个写者，限制单连接以串行化写入，避免锁冲突。
	sqlDB.SetMaxOpenConns(1)
	// WAL 提升读写并发；busy_timeout 让短暂的锁竞争自动重试；
	// foreign_keys 打开外键约束（SQLite 默认关闭），保证级联删除生效。
	for _, pragma := range []string{"PRAGMA journal_mode = WAL", "PRAGMA busy_timeout = 5000", "PRAGMA foreign_keys = ON"} {
		if err = db.Exec(pragma).Error; err != nil {
			sqlDB.Close()
			return nil, err
		}
	}
	if err = migrate.Run(db, freshDatabase); err != nil {
		sqlDB.Close()
		return nil, err
	}
	if err = coding.MigrateOrchestration(db); err != nil {
		sqlDB.Close()
		return nil, err
	}
	// 用户导入的 Live2D 模型集中存放，由 /models 只读路由提供。
	modelsDir := filepath.Join(cfg.DataDir, "models")
	if err = os.MkdirAll(modelsDir, 0700); err != nil {
		sqlDB.Close()
		return nil, err
	}
	// 初始模型随数据目录分发，缺失时跳过导入，不参与二进制打包。
	assetsDir := filepath.Join(cfg.DataDir, "assets")
	if err = os.MkdirAll(assetsDir, 0700); err != nil {
		sqlDB.Close()
		return nil, err
	}
	// 场景媒体与数据库记录分离存储，文件名即素材 ID，便于定位与清理。
	mediaDir := filepath.Join(cfg.DataDir, "scene-media")
	if err = os.MkdirAll(mediaDir, 0700); err != nil {
		sqlDB.Close()
		return nil, err
	}
	// 业务服务按依赖方向自底向上构造：设置与记忆不依赖其他模块，
	// 对话服务再组合角色、设置与 agentcore ADK 智能体。
	ss := settings.New(db, cfg)
	cs := &character.Service{DB: db, ModelsDir: modelsDir, AssetsDir: assetsDir}
	if err = cs.EnsureInitialModels(); err != nil {
		sqlDB.Close()
		return nil, err
	}
	ds := &desktop.Module{}
	assets := &sceneassets.Module{Service: &sceneassets.Service{DB: db, MediaDir: mediaDir}}
	memories := &memory.Service{DB: db}
	chatAgent := &agent.Service{Memory: memories, Characters: cs}
	conversations := &conversation.Service{DB: db, Characters: cs, Settings: ss, Agent: chatAgent}
	live, err := livemode.New(db, ss, cs, chatAgent)
	if err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("读取直播配置: %w", err)
	}
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	// LocalOnly 负责 Host/Origin 校验与写操作来源限制，Recovery 防止单请求 panic 拖垮服务。
	r.Use(gin.Recovery(), middleware.LocalOnly(ds.Available))
	r.Use(func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			// 本地接口随数据实时变化，禁止浏览器缓存，避免读到过期设置或会话。
			c.Header("Cache-Control", "no-store")
			// 普通 JSON 请求限制 26MB；导入与场景上传走 multipart，单独放开限制。
			if c.Request.Method != "GET" && c.Request.URL.Path != "/api/v1/characters/import" &&
				c.Request.URL.Path != "/api/v1/scene-assets" && c.Request.URL.Path != "/api/v1/coding/plugins/import" {
				c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 26<<20)
			}
		}
		c.Next()
	})
	// 健康检查供前端判断后端是否已就绪。
	r.GET("/api/v1/health", func(c *gin.Context) { pkg.OK(c, gin.H{"status": "ok", "version": "0.1.0", "agent": "agentcore"}) })
	// 业务模块统一挂载到 /api/v1；场景媒体路由不经过 API 分组，单独注册。
	plugins := piplugins.New(filepath.Join(cfg.DataDir, "pi-plugins"), ds.Available)
	plugins.ConfigureHost()
	plugins.ConfigureHostCompletion(
		func() (piplugins.HostCompletionModel, error) {
			cfg, err := ss.Get()
			return piplugins.HostCompletionModel{
				Key: cfg.LLM.Provider + "/" + cfg.LLM.Model, Name: cfg.LLM.Model, IsDefault: true,
			}, err
		},
		func(ctx context.Context, request piplugins.HostCompletionRequest) (string, error) {
			cfg, err := ss.Get()
			if err != nil {
				return "", err
			}
			if request.ModelKey != "" && request.ModelKey != cfg.LLM.Provider+"/"+cfg.LLM.Model {
				return "", fmt.Errorf("插件请求的模型与当前配置不一致")
			}
			cfg.LLM.MaxTokens = request.MaxTokens
			return agent.CompleteText(ctx, cfg.LLM, request.System, request.Prompt)
		},
	)
	terminal := coding.NewTerminalService()
	debugBrowser := coding.NewBrowserDebugService()
	code := &coding.Module{
		DB: db, Settings: ss, RuntimeDir: cfg.PiRuntimeDir, StateDir: filepath.Join(cfg.DataDir, "coding-sessions"),
		DesktopAvailable: ds.Available, PickDirectory: ds.PickDirectory,
		PluginEnabled: plugins.Enabled, Plugins: plugins,
		Terminal: terminal, BrowserDebug: debugBrowser,
	}
	plugins.ConfigureHostWorkspace(code.PluginWorkspaceCall)
	router.Register(r, &character.Module{Service: cs}, &settings.Module{Service: ss, Agent: chatAgent}, &conversation.Module{Service: conversations}, &speech.Module{Characters: cs, Settings: ss, TTS: tts.New(cfg.TTSDir)}, ds, assets, &memory.Module{Service: memories}, &livemode.Module{Service: live}, code, plugins)
	assets.RegisterMedia(r)
	cubism2Runtime := filepath.Join(cfg.DataDir, "cubism2", "live2d.min.js")
	r.GET("/api/v1/characters/cubism2-runtime", func(c *gin.Context) {
		file, err := os.Open(cubism2Runtime)
		if err != nil {
			c.Status(404)
			return
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			c.Status(404)
			return
		}
		c.Header("Content-Type", "text/javascript; charset=utf-8")
		http.ServeContent(c.Writer, c.Request, info.Name(), info.ModTime(), file)
	})
	// 模型文件只读映射到数据目录：逐级清理路径并拒绝绝对路径与 ..，防止路径穿越。
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
	// 前端资源必须最后注册：其 NoRoute 兜底会接管所有未匹配的 GET 请求。
	webui.Register(r)
	return &App{Router: r, Desktop: ds, DB: db, Config: cfg, Live: live, Terminal: terminal, BrowserDebug: debugBrowser, Coding: code, Plugins: plugins}, nil
}

// Listen 在配置的地址上监听，并把路由交给后台运行的 http.Server。
// 先同步监听端口，端口被占用时能立即返回错误，而不是静默失败。
func (a *App) Listen() (*http.Server, net.Listener, error) {
	listener, err := net.Listen("tcp", fmt.Sprintf("%s:%d", a.Config.Host, a.Config.Port))
	if err != nil {
		return nil, nil, err
	}
	server := &http.Server{Handler: a.Router, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		// 正常关闭（ErrServerClosed）不算错误，其余错误记录后退出。
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			slog.Error("HTTP 服务退出", "error", err)
		}
	}()
	return server, listener, nil
}

// Close 关闭底层数据库连接，供进程退出时释放文件句柄。
func (a *App) Close() {
	a.Terminal.Close()
	a.BrowserDebug.Close()
	a.Coding.StopOrchestration()
	a.Plugins.CloseHost()
	if err := a.Live.Stop(); err != nil {
		slog.Error("结束直播记录失败", "error", err)
	}
	db, err := a.DB.DB()
	if err == nil {
		_ = db.Close()
	}
}
