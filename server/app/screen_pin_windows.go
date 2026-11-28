//go:build windows && !headless

package app

import (
	"errors"
	"image"
	"image/draw"
	"runtime"
	"sync"
	"unsafe"

	"github.com/lxn/win"
	windowsAPI "golang.org/x/sys/windows"
)

var (
	snipPinClass     = windowsAPI.StringToUTF16Ptr("Live2DStudio.PinnedSnip")
	snipPinTitle     = windowsAPI.StringToUTF16Ptr("Live2D Studio · 贴图（右键菜单）")
	registerPinClass sync.Once
	snipPinClassAtom win.ATOM
	pinnedSnips      sync.Map // Windows thread ID -> *pinnedSnip
)

type pinnedSnip struct {
	image     *image.RGBA
	imageArea image.Rectangle
	closed    bool
}

const (
	pinCopy uint32 = iota + 1
	pinSave
	pinToggleTopmost
	pinDelete
)

func pinSnip(img *image.RGBA, at image.Point, display image.Rectangle, padding int) error {
	ready := make(chan error, 1)
	go showPinnedSnip(img, at, display, padding, ready)
	return <-ready
}

func showPinnedSnip(img *image.RGBA, at image.Point, display image.Rectangle, padding int, ready chan<- error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer useSnipPhysicalPixels()()
	original := image.NewRGBA(image.Rectangle{Max: img.Bounds().Size()})
	draw.Draw(original, original.Bounds(), img, img.Bounds().Min, draw.Src)
	img = original
	padding = min(padding, (min(display.Dx(), display.Dy())-1)/2)
	available := display.Inset(padding)
	width, height := img.Rect.Dx(), img.Rect.Dy()
	if width > available.Dx() || height > available.Dy() {
		if width*available.Dy() > height*available.Dx() {
			img = fitScreenSnip(img, max(available.Dx(), height*available.Dx()/width)).(*image.RGBA)
		} else {
			img = fitScreenSnip(img, max(width*available.Dy()/height, available.Dy())).(*image.RGBA)
		}
		width, height = img.Rect.Dx(), img.Rect.Dy()
	}
	instance := win.GetModuleHandle(nil)
	if !registerPinnedSnipWindow(instance) {
		ready <- errors.New("无法注册贴图窗口")
		return
	}
	imageArea := image.Rect(padding, padding, padding+width, padding+height)
	pin := &pinnedSnip{image: original, imageArea: imageArea}
	thread := win.GetCurrentThreadId()
	pinnedSnips.Store(thread, pin)
	defer pinnedSnips.Delete(thread)
	x := constrain(at.X, available.Min.X, available.Max.X-width) - padding
	y := constrain(at.Y, available.Min.Y, available.Max.Y-height) - padding
	hwnd := win.CreateWindowEx(win.WS_EX_TOPMOST|win.WS_EX_TOOLWINDOW|win.WS_EX_LAYERED, snipPinClass, snipPinTitle,
		win.WS_POPUP, int32(x), int32(y), int32(width+2*padding), int32(height+2*padding), 0, 0, instance, nil)
	if hwnd == 0 {
		ready <- errors.New("无法打开贴图窗口")
		return
	}
	defer win.DestroyWindow(hwnd)
	if err := presentPinnedSnip(hwnd, img, padding); err != nil {
		ready <- err
		return
	}
	win.ShowWindow(hwnd, win.SW_SHOWNOACTIVATE)
	ready <- nil
	for !pin.closed {
		var message win.MSG
		if win.GetMessage(&message, 0, 0, 0) <= 0 {
			break
		}
		win.TranslateMessage(&message)
		win.DispatchMessage(&message)
	}
}

func registerPinnedSnipWindow(instance win.HINSTANCE) bool {
	registerPinClass.Do(func() {
		wc := win.WNDCLASSEX{
			LpfnWndProc:   windowsAPI.NewCallback(pinnedSnipWindowProc),
			HInstance:     instance,
			HCursor:       win.LoadCursor(0, (*uint16)(unsafe.Pointer(uintptr(win.IDC_SIZEALL)))),
			LpszClassName: snipPinClass,
		}
		wc.CbSize = uint32(unsafe.Sizeof(wc))
		snipPinClassAtom = win.RegisterClassEx(&wc)
	})
	return snipPinClassAtom != 0
}

func pinnedSnipWindowProc(hwnd win.HWND, msg uint32, wParam, lParam uintptr) uintptr {
	value, ok := pinnedSnips.Load(win.GetCurrentThreadId())
	if !ok {
		return win.DefWindowProc(hwnd, msg, wParam, lParam)
	}
	pin := value.(*pinnedSnip)
	switch msg {
	case win.WM_NCHITTEST:
		point := win.POINT{X: int32(int16(lParam)), Y: int32(int16(lParam >> 16))}
		if win.ScreenToClient(hwnd, &point) && !image.Pt(int(point.X), int(point.Y)).In(pin.imageArea) {
			hit := win.HTTRANSPARENT
			return uintptr(hit)
		}
		return win.HTCLIENT
	case win.WM_LBUTTONDOWN:
		point := win.POINT{X: int32(int16(lParam)), Y: int32(int16(lParam >> 16))}
		win.ClientToScreen(hwnd, &point)
		return win.DefWindowProc(hwnd, win.WM_NCLBUTTONDOWN, win.HTCAPTION, pinMenuCoordinates(point))
	case win.WM_RBUTTONUP:
		point := win.POINT{X: int32(int16(lParam)), Y: int32(int16(lParam >> 16))}
		win.ClientToScreen(hwnd, &point)
		win.PostMessage(hwnd, win.WM_CONTEXTMENU, uintptr(hwnd), pinMenuCoordinates(point))
		return 0
	case win.WM_NCRBUTTONUP:
		win.PostMessage(hwnd, win.WM_CONTEXTMENU, uintptr(hwnd), lParam)
		return 0
	case win.WM_CONTEXTMENU:
		if win.IsWindowVisible(hwnd) {
			pin.showMenu(hwnd, lParam)
		}
		return 0
	case win.WM_CLOSE:
		pin.closed = true
		return 0
	case win.WM_KEYDOWN:
		if wParam == win.VK_ESCAPE {
			pin.closed = true
			return 0
		}
	}
	return win.DefWindowProc(hwnd, msg, wParam, lParam)
}

func pinMenuCoordinates(point win.POINT) uintptr {
	return uintptr(uint16(point.X)) | uintptr(uint16(point.Y))<<16
}

func pinnedSnipIsTopmost(hwnd win.HWND) bool {
	return win.GetWindowLong(hwnd, win.GWL_EXSTYLE)&win.WS_EX_TOPMOST != 0
}

func makePinnedSnipMenu(topmost bool) win.HMENU {
	menu := win.CreatePopupMenu()
	if menu == 0 {
		return 0
	}
	items := [...]struct {
		id    uint32
		label string
	}{
		{pinCopy, "复制图片"},
		{pinSave, "保存 PNG"},
		{pinToggleTopmost, "置顶"},
		{},
		{pinDelete, "删除贴图"},
	}
	for i, item := range items {
		info := win.MENUITEMINFO{FMask: win.MIIM_FTYPE}
		info.CbSize = uint32(unsafe.Sizeof(info))
		if item.id == 0 {
			info.FType = win.MFT_SEPARATOR
		} else {
			info.FMask |= win.MIIM_ID | win.MIIM_STRING | win.MIIM_STATE
			info.WID = item.id
			info.DwTypeData = windowsAPI.StringToUTF16Ptr(item.label)
			if item.id == pinToggleTopmost && topmost {
				info.FState = win.MFS_CHECKED
			}
		}
		if !win.InsertMenuItem(menu, uint32(i), true, &info) {
			win.DestroyMenu(menu)
			return 0
		}
	}
	return menu
}

func (pin *pinnedSnip) showMenu(hwnd win.HWND, lParam uintptr) {
	menu := makePinnedSnipMenu(pinnedSnipIsTopmost(hwnd))
	if menu == 0 {
		return
	}
	defer win.DestroyMenu(menu)
	point := win.POINT{X: int32(int16(lParam)), Y: int32(int16(lParam >> 16))}
	if point.X == -1 && point.Y == -1 {
		var bounds win.RECT
		win.GetWindowRect(hwnd, &bounds)
		point.X = bounds.Left + (bounds.Right-bounds.Left)/2
		point.Y = bounds.Top + (bounds.Bottom-bounds.Top)/2
	}
	win.SetForegroundWindow(hwnd)
	choice := win.TrackPopupMenu(menu, win.TPM_RETURNCMD|win.TPM_NONOTIFY|win.TPM_RIGHTBUTTON,
		point.X, point.Y, 0, hwnd, nil)
	win.PostMessage(hwnd, win.WM_NULL, 0, 0)
	if err := pin.runMenuCommand(hwnd, choice); err != nil {
		win.MessageBox(hwnd, windowsAPI.StringToUTF16Ptr(err.Error()), snipPinTitle, win.MB_OK|win.MB_ICONERROR)
	}
}

func (pin *pinnedSnip) runMenuCommand(hwnd win.HWND, choice uint32) error {
	switch choice {
	case pinCopy:
		return copySnip(hwnd, pin.image)
	case pinSave:
		_, err := saveSnip(hwnd, func() image.Image { return pin.image })
		return err
	case pinToggleTopmost:
		after := win.HWND_TOPMOST
		if pinnedSnipIsTopmost(hwnd) {
			after = win.HWND_NOTOPMOST
		}
		if !win.SetWindowPos(hwnd, after, 0, 0, 0, 0, win.SWP_NOMOVE|win.SWP_NOSIZE|win.SWP_NOACTIVATE) {
			return errors.New("无法切换贴图置顶状态")
		}
	case pinDelete:
		pin.closed = true
	}
	return nil
}
