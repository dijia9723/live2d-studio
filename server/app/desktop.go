//go:build !headless

// 本文件实现桌面构建（未加 headless 标签）下的 Wails 主窗口与桌宠窗口；
// headless 构建由 headless.go 提供同名 runDesktop 桩函数。

package app

import (
	"net/url"
	"os"
	"strconv"
	"sync"

	"server/internal/bootstrap"
	"server/internal/modules/desktop"
	"server/internal/webui"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// windows 保存 Wails 应用与窗口句柄，供前端通过绑定的方法控制置顶与桌宠显示。
type windows struct {
	mu       sync.Mutex
	app      *application.App
	main     *application.WebviewWindow
	pet      *application.WebviewWindow
	switchID uint64
}

// Pin 控制主窗口是否始终置顶。
func (w *windows) Pin(enabled bool) { w.main.SetAlwaysOnTop(enabled) }

// Pet 按需创建、显示或隐藏透明无边框的桌宠窗口，窗口实例会被复用。
func (w *windows) Pet(enabled bool, handoff *desktop.PetHandoff) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if enabled {
		w.main.Hide()
		target := w.switchURL(true, handoff)
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
				URL:              target,
				Windows: application.WindowsWindow{
					DisableFramelessWindowDecorations: true,
					WebView2CompositionHosting:        true,
				},
			})
			w.pet.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
				event.Cancel()
				go w.Pet(false, nil)
			})
			excludePetFromCapture(w.pet)
		} else {
			w.pet.SetURL(target)
			w.pet.Show()
		}
		return
	}
	if w.pet != nil {
		w.pet.Hide()
		// 切回工作台时卸载桌宠页面，释放它持有的采集流和识别线程。
		w.pet.SetURL("about:blank")
	}
	if handoff != nil {
		w.main.SetURL(w.switchURL(false, handoff))
	}
	w.main.Show()
	w.main.Focus()
}

func (w *windows) switchURL(pet bool, handoff *desktop.PetHandoff) string {
	w.switchID++
	params := url.Values{"switch": {strconv.FormatUint(w.switchID, 10)}}
	if pet {
		params.Set("pet", "1")
	}
	if handoff != nil {
		params.Set("character", handoff.CharacterID)
		params.Set("conversation", handoff.ConversationID)
		if pet && handoff.WatchID != "" {
			// 片段只交给桌宠前端，不进入 HTTP 请求地址。
			return "/?" + params.Encode() + "#watch=" + url.QueryEscape(handoff.WatchID)
		}
		if pet && handoff.ChooseWindow {
			params.Set("choose_window", "1")
		}
	}
	return "/?" + params.Encode()
}

func (w *windows) PickDirectory() (string, error) {
	return w.app.Dialog.OpenFile().CanChooseFiles(false).CanChooseDirectories(true).
		AttachToWindow(w.main).SetTitle("打开编码项目").PromptForSingleSelection()
}

// runDesktop 启动 Wails 应用：页面资源经 DesktopHandler 代理本地 HTTP 服务，
// 既保证原生运行时可用，又避免聊天 SSE 被 Wails 的资源层整体缓冲。
func runDesktop(backend *bootstrap.App, address string) error {
	proxy, err := webui.DesktopHandler(address, os.Getenv("FRONTEND_DEVSERVER_URL"))
	if err != nil {
		return err
	}
	app := application.New(application.Options{Name: "Live2D Studio", Description: "你的 AI 伙伴工作室", Assets: application.AssetOptions{Handler: proxy}, Mac: application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true}})
	window := app.Window.NewWithOptions(application.WebviewWindowOptions{Title: "Live2D Studio", Width: 1440, Height: 940, MinWidth: 1024, MinHeight: 720, BackgroundColour: application.NewRGB(248, 247, 251), URL: "/"})
	shell := &windows{app: app, main: window}
	registerScreenCapture(app, shell)
	backend.Desktop.Set(shell)
	backend.Plugins.StartHost()
	return app.Run()
}
