//go:build !headless

// 本文件实现桌面构建（未加 headless 标签）下的 Wails 主窗口与桌宠窗口；
// headless 构建由 headless.go 提供同名 runDesktop 桩函数。

package app

import (
	"os"
	"sync"

	"server/internal/bootstrap"
	"server/internal/webui"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// windows 保存 Wails 应用与窗口句柄，供前端通过绑定的方法控制置顶与桌宠显示。
type windows struct {
	mu   sync.Mutex
	app  *application.App
	main *application.WebviewWindow
	pet  *application.WebviewWindow
	url  string
}

// Pin 控制主窗口是否始终置顶。
func (w *windows) Pin(enabled bool) { w.main.SetAlwaysOnTop(enabled) }

// Pet 按需创建、显示或隐藏透明无边框的桌宠窗口，窗口实例会被复用。
func (w *windows) Pet(enabled bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if enabled {
		if w.pet == nil {
			w.pet = w.app.Window.NewWithOptions(application.WebviewWindowOptions{
				Name:             "pet",
				Title:            "Live2D Studio · 桌宠",
				Width:            380,
				Height:           540,
				MinWidth:         280,
				MinHeight:        380,
				AlwaysOnTop:      true,
				Frameless:        true,
				BackgroundType:   application.BackgroundTypeTransparent,
				BackgroundColour: application.NewRGBA(0, 0, 0, 0),
				URL:              "/?pet=1",
				Windows: application.WindowsWindow{
					DisableFramelessWindowDecorations: true,
					WebView2CompositionHosting:        true,
				},
			})
		} else {
			w.pet.Show()
		}
	} else if w.pet != nil {
		w.pet.Hide()
	}
}

// runDesktop 启动 Wails 应用：页面资源经 DesktopHandler 代理本地 HTTP 服务，
// 既保证原生运行时可用，又避免聊天 SSE 被 Wails 的资源层整体缓冲。
func runDesktop(backend *bootstrap.App, address string) error {
	proxy, err := webui.DesktopHandler(address, os.Getenv("FRONTEND_DEVSERVER_URL"))
	if err != nil {
		return err
	}
	app := application.New(application.Options{Name: "Live2D Studio", Description: "你的 AI 伙伴工作室", Assets: application.AssetOptions{Handler: proxy}, Mac: application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true}})
	registerScreenCapture(app)
	window := app.Window.NewWithOptions(application.WebviewWindowOptions{Title: "Live2D Studio", Width: 1440, Height: 940, MinWidth: 1024, MinHeight: 720, BackgroundColour: application.NewRGB(248, 247, 251), URL: "/"})
	backend.Desktop.Set(&windows{app: app, main: window, url: address})
	return app.Run()
}
