//go:build !headless

// 本文件实现桌面构建中的 Wails 工作台、桌宠与编码窗口。
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

type windowMode uint8

const (
	studioMode windowMode = iota
	petMode
	codingMode
)

type windows struct {
	mu       sync.Mutex
	app      *application.App
	main     *application.WebviewWindow
	pet      *application.WebviewWindow
	coding   *application.WebviewWindow
	mode     windowMode
	switchID uint64
}

// Pin 控制主窗口是否始终置顶。
func (w *windows) Pin(enabled bool) { w.main.SetAlwaysOnTop(enabled) }

func (w *windows) Pet(enabled bool, handoff *desktop.PetHandoff) {
	w.switchMode(petMode, enabled, handoff)
}

func (w *windows) Coding(enabled bool) {
	w.switchMode(codingMode, enabled, nil)
}

func (w *windows) currentWindow() *application.WebviewWindow {
	switch w.mode {
	case petMode:
		return w.pet
	case codingMode:
		return w.coding
	default:
		return w.main
	}
}

func (w *windows) switchMode(mode windowMode, enabled bool, handoff *desktop.PetHandoff) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !enabled {
		if w.mode != mode {
			return
		}
		mode = studioMode
	}
	if w.mode != mode {
		w.currentWindow().Hide()
		if w.mode == petMode {
			// 离开桌宠模式时释放采集流和识别线程。
			w.pet.SetURL("about:blank")
		}
	}
	switch mode {
	case petMode:
		w.preparePet(w.switchURL(true, handoff))
	case codingMode:
		if w.coding == nil {
			w.coding = w.app.Window.NewWithOptions(application.WebviewWindowOptions{
				Name: "coding", Title: "Live2D Studio · 编码工作台", Hidden: true,
				Width: 1440, Height: 940, MinWidth: 1000, MinHeight: 680,
				BackgroundColour: application.NewRGB(27, 25, 32), URL: "/?coding=1#/coding",
			})
			w.returnOnClose(w.coding, codingMode)
		}
	case studioMode:
		if handoff != nil {
			w.main.SetURL(w.switchURL(false, handoff))
		}
	}
	w.mode = mode
	showWindow(w.currentWindow())
}

func (w *windows) preparePet(target string) {
	if w.pet != nil {
		w.pet.SetURL(target)
		return
	}
	w.pet = w.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "pet",
		Title:            "Live2D Studio · 桌宠",
		Hidden:           true,
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
	w.returnOnClose(w.pet, petMode)
	excludePetFromCapture(w.pet)
}

func (w *windows) returnOnClose(window *application.WebviewWindow, mode windowMode) {
	window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		event.Cancel()
		go w.switchMode(mode, false, nil)
	})
}

func showWindow(window application.Window) {
	window.Show()
	if window.IsMinimised() {
		window.UnMinimise()
	}
	window.Focus()
}

func (w *windows) restoreWindow(owner application.Window) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if owner == w.currentWindow() {
		showWindow(owner)
	}
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

func (w *windows) PickDirectory(title, directory string) (string, error) {
	w.mu.Lock()
	owner := w.currentWindow()
	w.mu.Unlock()
	dialog := w.app.Dialog.OpenFile().CanChooseFiles(false).CanChooseDirectories(true).
		AttachToWindow(owner).SetTitle(title)
	if directory != "" {
		dialog.SetDirectory(directory).CanCreateDirectories(true)
	}
	path, err := dialog.PromptForSingleSelection()
	// Wails exposes Windows dialog cancellation through an internal error sentinel.
	if err != nil && err.Error() == "cancelled by user" {
		return "", nil
	}
	return path, err
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
	window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		event.Cancel()
		go app.Quit()
	})
	shell := &windows{app: app, main: window}
	registerScreenCapture(app, shell)
	backend.Desktop.Set(shell)
	backend.Plugins.StartHost()
	return app.Run()
}
