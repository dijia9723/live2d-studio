//go:build !windows && !headless

package app

import "github.com/wailsapp/wails/v3/pkg/application"

func registerScreenCapture(*application.App, *windows) {}

func excludePetFromCapture(*application.WebviewWindow) {}
