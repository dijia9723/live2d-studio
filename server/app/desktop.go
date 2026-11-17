//go:build !headless

package app

import (
	"sync"

	"server/internal/bootstrap"
	"server/internal/webui"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type windows struct {
	mu   sync.Mutex
	app  *application.App
	main *application.WebviewWindow
	pet  *application.WebviewWindow
	url  string
}

func (w *windows) Pin(enabled bool) { w.main.SetAlwaysOnTop(enabled) }
func (w *windows) Pet(enabled bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if enabled {
		if w.pet == nil {
			w.pet = w.app.Window.NewWithOptions(application.WebviewWindowOptions{Name: "pet", Title: "Live2D Studio · 桌宠", Width: 380, Height: 540, MinWidth: 280, MinHeight: 380, AlwaysOnTop: true, Frameless: true, BackgroundType: application.BackgroundTypeTransparent, BackgroundColour: application.NewRGBA(0, 0, 0, 0), URL: "/?pet=1"})
		} else {
			w.pet.Show()
		}
	} else if w.pet != nil {
		w.pet.Hide()
	}
}
func runDesktop(backend *bootstrap.App, address string) error {
	proxy, err := webui.DesktopHandler(address)
	if err != nil {
		return err
	}
	app := application.New(application.Options{Name: "Live2D Studio", Description: "你的 AI 伙伴工作室", Assets: application.AssetOptions{Handler: proxy}, Mac: application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true}})
	window := app.Window.NewWithOptions(application.WebviewWindowOptions{Title: "Live2D Studio", Width: 1440, Height: 940, MinWidth: 1024, MinHeight: 720, BackgroundColour: application.NewRGB(248, 247, 251), URL: "/"})
	backend.Desktop.Set(&windows{app: app, main: window, url: address})
	return app.Run()
}
