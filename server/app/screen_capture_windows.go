//go:build windows && !headless

package app

import (
	"context"
	"errors"
	"image"
	"runtime"
	"sync"
	"sync/atomic"
	"unsafe"

	"github.com/kbinani/screenshot"
	"github.com/lxn/win"
	"github.com/wailsapp/wails/v3/pkg/application"
	windowsAPI "golang.org/x/sys/windows"
)

// ScreenCapture is a Wails-only service. The HTTP server cannot start a capture or read its result.
type ScreenCapture struct {
	busy atomic.Bool
}

func registerScreenCapture(app *application.App) {
	app.RegisterService(application.NewService(&ScreenCapture{}))
}

func (s *ScreenCapture) Snip(ctx context.Context) (*screenSnip, error) {
	if !s.busy.CompareAndSwap(false, true) {
		return nil, errors.New("已有截图正在进行")
	}
	defer s.busy.Store(false)
	frame, selection, err := selectDesktopRegion(ctx)
	if err != nil || selection.Empty() {
		return nil, err
	}
	return encodeScreenSnip(frame.SubImage(selection))
}

var (
	setThreadDPI      = windowsAPI.NewLazySystemDLL("user32.dll").NewProc("SetThreadDpiAwarenessContext")
	snipClass         = windowsAPI.StringToUTF16Ptr("Live2DStudio.ScreenCapture")
	snipTitle         = windowsAPI.StringToUTF16Ptr("Live2D Studio · 屏幕截图")
	snipHint          = windowsAPI.StringToUTF16("拖动鼠标框选 · Esc 或右键取消")
	registerSnipClass sync.Once
	snipClassAtom     win.ATOM
	snipSelections    sync.Map // Windows thread ID -> *desktopSelection
)

type desktopSelection struct {
	desktop                    image.Rectangle
	bright, dim                screenBitmap
	hint                       win.RECT
	start                      image.Point
	rect                       image.Rectangle
	dragging, finished, closed bool
}

func selectDesktopRegion(ctx context.Context) (*image.RGBA, image.Rectangle, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if setThreadDPI.Find() == nil {
		// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4) keeps mouse and bitmap coordinates in physical pixels.
		if previous, _, _ := setThreadDPI.Call(^uintptr(3)); previous != 0 {
			defer setThreadDPI.Call(previous)
		}
	}
	desktop := image.Rectangle{}
	for i := range screenshot.NumActiveDisplays() {
		desktop = desktop.Union(screenshot.GetDisplayBounds(i))
	}
	if desktop.Empty() || int64(desktop.Dx())*int64(desktop.Dy()) > 64<<20 {
		return nil, image.Rectangle{}, errors.New("无法获取可用的 Windows 桌面范围")
	}
	frame, err := screenshot.CaptureRect(desktop)
	if err != nil {
		return nil, image.Rectangle{}, errors.New("无法读取 Windows 桌面")
	}
	if ctx.Err() != nil {
		return nil, image.Rectangle{}, nil
	}

	bright, err := newScreenBitmap(frame, 0)
	if err != nil {
		return nil, image.Rectangle{}, err
	}
	defer bright.close()
	dim, err := newScreenBitmap(frame, 1)
	if err != nil {
		return nil, image.Rectangle{}, err
	}
	defer dim.close()
	instance := win.GetModuleHandle(nil)
	registerSnipClass.Do(func() {
		wc := win.WNDCLASSEX{
			LpfnWndProc:   windowsAPI.NewCallback(snipWindowProc),
			HInstance:     instance,
			HCursor:       win.LoadCursor(0, (*uint16)(unsafe.Pointer(uintptr(win.IDC_CROSS)))),
			LpszClassName: snipClass,
		}
		wc.CbSize = uint32(unsafe.Sizeof(wc))
		snipClassAtom = win.RegisterClassEx(&wc)
	})
	if snipClassAtom == 0 {
		return nil, image.Rectangle{}, errors.New("无法注册截图窗口")
	}
	selection := &desktopSelection{desktop: desktop, bright: bright, dim: dim}
	selection.setHint()
	thread := win.GetCurrentThreadId()
	snipSelections.Store(thread, selection)
	defer snipSelections.Delete(thread)
	hwnd := win.CreateWindowEx(
		win.WS_EX_TOPMOST|win.WS_EX_TOOLWINDOW, snipClass, snipTitle, win.WS_POPUP,
		int32(desktop.Min.X), int32(desktop.Min.Y), int32(desktop.Dx()), int32(desktop.Dy()),
		0, 0, instance, nil,
	)
	if hwnd == 0 {
		return nil, image.Rectangle{}, errors.New("无法打开截图窗口")
	}
	defer win.DestroyWindow(hwnd)
	stop := context.AfterFunc(ctx, func() { win.PostMessage(hwnd, win.WM_CLOSE, 0, 0) })
	defer stop()
	win.ShowWindow(hwnd, win.SW_SHOW)
	win.SetForegroundWindow(hwnd)
	win.SetFocus(hwnd)
	win.UpdateWindow(hwnd)
	for !selection.closed {
		var message win.MSG
		if win.GetMessage(&message, 0, 0, 0) <= 0 {
			break
		}
		win.TranslateMessage(&message)
		win.DispatchMessage(&message)
	}
	if !selection.finished || ctx.Err() != nil {
		return nil, image.Rectangle{}, nil
	}
	return frame, selection.rect, nil
}

func snipWindowProc(hwnd win.HWND, msg uint32, wParam, lParam uintptr) uintptr {
	value, ok := snipSelections.Load(win.GetCurrentThreadId())
	if !ok {
		return win.DefWindowProc(hwnd, msg, wParam, lParam)
	}
	s := value.(*desktopSelection)
	switch msg {
	case win.WM_PAINT:
		s.paint(hwnd)
		return 0
	case win.WM_LBUTTONDOWN:
		s.start = s.cursor()
		s.dragging = true
		win.SetCapture(hwnd)
		win.InvalidateRect(hwnd, &s.hint, false)
		return 0
	case win.WM_MOUSEMOVE:
		if s.dragging {
			old := s.rect
			s.rect = s.region()
			dirty := toWinRect(old.Union(s.rect).Inset(-2))
			win.InvalidateRect(hwnd, &dirty, false)
		}
		return 0
	case win.WM_LBUTTONUP:
		if s.dragging {
			s.rect = s.region()
			s.dragging = false
			s.finished = !s.rect.Empty()
			win.ReleaseCapture()
			if s.finished {
				s.closed = true
			} else {
				win.InvalidateRect(hwnd, nil, false)
			}
		}
		return 0
	case win.WM_KEYDOWN:
		if wParam == win.VK_ESCAPE {
			s.closed = true
			return 0
		}
	case win.WM_CAPTURECHANGED:
		if s.dragging {
			s.closed = true
		}
	case win.WM_RBUTTONDOWN, win.WM_CLOSE, win.WM_DISPLAYCHANGE, win.WM_KILLFOCUS:
		s.closed = true
		return 0
	}
	return win.DefWindowProc(hwnd, msg, wParam, lParam)
}

func (s *desktopSelection) cursor() image.Point {
	var point win.POINT
	win.GetCursorPos(&point)
	return image.Pt(int(point.X), int(point.Y)).Sub(s.desktop.Min)
}

func (s *desktopSelection) region() image.Rectangle {
	end := s.cursor()
	return image.Rect(s.start.X, s.start.Y, end.X, end.Y).Intersect(s.desktop.Sub(s.desktop.Min))
}

func (s *desktopSelection) setHint() {
	point := s.cursor().Add(s.desktop.Min)
	monitor := s.desktop
	for i := range screenshot.NumActiveDisplays() {
		if bounds := screenshot.GetDisplayBounds(i); point.In(bounds) {
			monitor = bounds
			break
		}
	}
	monitor = monitor.Sub(s.desktop.Min)
	s.hint = toWinRect(image.Rect(monitor.Min.X, monitor.Min.Y+22, monitor.Max.X, monitor.Min.Y+62))
}

func (s *desktopSelection) paint(hwnd win.HWND) {
	var paint win.PAINTSTRUCT
	dc := win.BeginPaint(hwnd, &paint)
	defer win.EndPaint(hwnd, &paint)
	clip := paint.RcPaint
	win.BitBlt(dc, clip.Left, clip.Top, clip.Right-clip.Left, clip.Bottom-clip.Top, s.dim.dc, clip.Left, clip.Top, win.SRCCOPY)
	if !s.rect.Empty() {
		r := toWinRect(s.rect)
		win.BitBlt(dc, r.Left, r.Top, r.Right-r.Left, r.Bottom-r.Top, s.bright.dc, r.Left, r.Top, win.SRCCOPY)
		pen := win.SelectObject(dc, win.GetStockObject(win.WHITE_PEN))
		brush := win.SelectObject(dc, win.GetStockObject(win.NULL_BRUSH))
		win.Rectangle_(dc, r.Left, r.Top, r.Right, r.Bottom)
		win.SelectObject(dc, brush)
		win.SelectObject(dc, pen)
	} else if !s.dragging {
		win.SetBkMode(dc, win.TRANSPARENT)
		win.SetTextColor(dc, win.RGB(255, 255, 255))
		hint := s.hint
		win.DrawTextEx(dc, &snipHint[0], -1, &hint, win.DT_CENTER|win.DT_SINGLELINE|win.DT_VCENTER, nil)
	}
}

func toWinRect(rect image.Rectangle) win.RECT {
	return win.RECT{Left: int32(rect.Min.X), Top: int32(rect.Min.Y), Right: int32(rect.Max.X), Bottom: int32(rect.Max.Y)}
}

type screenBitmap struct {
	dc       win.HDC
	bitmap   win.HBITMAP
	previous win.HGDIOBJ
}

func newScreenBitmap(frame *image.RGBA, shade uint) (screenBitmap, error) {
	bitmap := screenBitmap{dc: win.CreateCompatibleDC(0)}
	if bitmap.dc == 0 {
		return screenBitmap{}, errors.New("无法创建截图画布")
	}
	var pixels unsafe.Pointer
	header := win.BITMAPINFOHEADER{
		BiWidth: int32(frame.Rect.Dx()), BiHeight: -int32(frame.Rect.Dy()),
		BiPlanes: 1, BiBitCount: 32, BiCompression: win.BI_RGB,
	}
	header.BiSize = uint32(unsafe.Sizeof(header))
	bitmap.bitmap = win.CreateDIBSection(bitmap.dc, &header, win.DIB_RGB_COLORS, &pixels, 0, 0)
	if bitmap.bitmap != 0 {
		bitmap.previous = win.SelectObject(bitmap.dc, win.HGDIOBJ(bitmap.bitmap))
	}
	if bitmap.previous == 0 || pixels == nil {
		bitmap.close()
		return screenBitmap{}, errors.New("无法建立截图预览")
	}
	dest := unsafe.Slice((*byte)(pixels), len(frame.Pix))
	for i := 0; i < len(dest); i += 4 {
		dest[i], dest[i+1], dest[i+2] = frame.Pix[i+2]>>shade, frame.Pix[i+1]>>shade, frame.Pix[i]>>shade
	}
	return bitmap, nil
}

func (b screenBitmap) close() {
	if b.previous != 0 {
		win.SelectObject(b.dc, b.previous)
	}
	if b.bitmap != 0 {
		win.DeleteObject(win.HGDIOBJ(b.bitmap))
	}
	win.DeleteDC(b.dc)
}
