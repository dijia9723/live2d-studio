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

	"github.com/google/uuid"
	"github.com/kbinani/screenshot"
	"github.com/lxn/win"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	windowsAPI "golang.org/x/sys/windows"
	"server/internal/modules/desktop"
)

// ScreenCapture is a Wails-only service. The HTTP server cannot start a capture or read its result.
type ScreenCapture struct {
	busy    atomic.Bool
	watchMu sync.Mutex
	watch   *screenWatch
	windows *windows
}

func registerScreenCapture(app *application.App, windows *windows) {
	app.RegisterService(application.NewService(&ScreenCapture{windows: windows}))
}

func (s *ScreenCapture) Snip(ctx context.Context, handoff desktop.PetHandoff) (*screenSnip, error) {
	if !s.busy.CompareAndSwap(false, true) {
		return nil, errors.New("已有截图正在进行")
	}
	defer s.busy.Store(false)
	owner, _ := ctx.Value(application.WindowKey).(application.Window)
	restore := owner != nil && owner.IsVisible()
	if restore {
		owner.Hide()
		dwmFlush.Call()
	}
	defer func() {
		if restore {
			if s.windows != nil {
				s.windows.restoreWindow(owner)
			} else {
				showWindow(owner)
			}
		}
	}()
	selection, err := selectDesktopRegion(ctx)
	if err != nil || selection == nil {
		return nil, err
	}
	if selection.watch.Empty() {
		return encodeScreenSnip(selection.image)
	}
	s.watchMu.Lock()
	id := uuid.NewString()
	s.watch = &screenWatch{id: id, bounds: selection.watch}
	s.watchMu.Unlock()
	if s.windows != nil {
		handoff.WatchID = id
		s.windows.Pet(true, &handoff)
		restore = false
	}
	return &screenSnip{WatchID: id, Width: selection.watch.Dx(), Height: selection.watch.Dy()}, nil
}

var (
	dwmFlush           = windowsAPI.NewLazySystemDLL("dwmapi.dll").NewProc("DwmFlush")
	setCaptureAffinity = windowsAPI.NewLazySystemDLL("user32.dll").NewProc("SetWindowDisplayAffinity")
	setThreadDPI       = windowsAPI.NewLazySystemDLL("user32.dll").NewProc("SetThreadDpiAwarenessContext")
	snipClass          = windowsAPI.StringToUTF16Ptr("Live2DStudio.ScreenCapture")
	snipTitle          = windowsAPI.StringToUTF16Ptr("Live2D Studio · 屏幕截图")
	snipHint           = windowsAPI.StringToUTF16("拖动鼠标框选 · Esc 或右键取消")
	registerSnipClass  sync.Once
	snipClassAtom      win.ATOM
	snipSelections     sync.Map // Windows thread ID -> *desktopSelection
)

func excludePetFromCapture(window *application.WebviewWindow) {
	// WDA_EXCLUDEFROMCAPTURE keeps the visible companion out of eligible Windows captures.
	apply := func() {
		if hwnd := window.NativeWindow(); hwnd != nil {
			setCaptureAffinity.Call(uintptr(hwnd), 0x11)
		}
	}
	window.OnWindowEvent(events.Common.WindowRuntimeReady, func(*application.WindowEvent) { apply() })
	apply()
}

type desktopSelection struct {
	snipSelection
	desktop                image.Rectangle
	displays               []image.Rectangle
	frame                  *image.RGBA
	bright, dim            screenBitmap
	buffer                 screenBitmap
	hint                   image.Rectangle
	dpi                    int
	penHandle              win.HGDIOBJ
	pressed, hovered       snipAction
	tooltip                snipAction
	dialog, attach, closed bool
	watch                  bool
}

type desktopSnipResult struct {
	image *image.RGBA
	watch image.Rectangle
}

func selectDesktopRegion(ctx context.Context) (*desktopSnipResult, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer useSnipPhysicalPixels()()
	desktop := image.Rectangle{}
	var displays []image.Rectangle
	for i := range screenshot.NumActiveDisplays() {
		bounds := screenshot.GetDisplayBounds(i)
		if !bounds.Empty() {
			displays = append(displays, bounds)
			desktop = desktop.Union(bounds)
		}
	}
	if desktop.Empty() || int64(desktop.Dx())*int64(desktop.Dy()) > 64<<20 {
		return nil, errors.New("无法获取可用的 Windows 桌面范围")
	}
	frame, err := screenshot.CaptureRect(desktop)
	if err != nil {
		return nil, errors.New("无法读取 Windows 桌面")
	}
	if ctx.Err() != nil {
		return nil, nil
	}

	bright, err := newScreenBitmap(frame, 0)
	if err != nil {
		return nil, err
	}
	defer bright.close()
	dim, err := newScreenBitmap(frame, 1)
	if err != nil {
		return nil, err
	}
	defer dim.close()
	buffer, _, err := newScreenSurface(min(frame.Rect.Dx(), snipPaintTile), min(frame.Rect.Dy(), snipPaintTile))
	if err != nil {
		return nil, err
	}
	defer buffer.close()
	instance := win.GetModuleHandle(nil)
	if !registerSelectionWindow(instance) {
		return nil, errors.New("无法注册截图窗口")
	}
	for i := range displays {
		displays[i] = displays[i].Sub(desktop.Min)
	}
	selection := &desktopSelection{
		snipSelection: snipSelection{bounds: frame.Bounds()},
		desktop:       desktop, displays: displays, frame: frame, bright: bright, dim: dim, buffer: buffer, dpi: 96,
	}
	thread := win.GetCurrentThreadId()
	snipSelections.Store(thread, selection)
	defer snipSelections.Delete(thread)
	hwnd := win.CreateWindowEx(
		win.WS_EX_TOPMOST|win.WS_EX_TOOLWINDOW, snipClass, snipTitle, win.WS_POPUP,
		int32(desktop.Min.X), int32(desktop.Min.Y), int32(desktop.Dx()), int32(desktop.Dy()),
		0, 0, instance, nil,
	)
	if hwnd == 0 {
		return nil, errors.New("无法打开截图窗口")
	}
	defer win.DestroyWindow(hwnd)
	selection.dpi = max(96, int(win.GetDpiForWindow(hwnd)))
	selection.setHint()
	selection.penHandle = createSnipPen()
	if selection.penHandle != 0 {
		defer win.DeleteObject(selection.penHandle)
	}
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
	if ctx.Err() != nil {
		return nil, nil
	}
	if selection.watch {
		return &desktopSnipResult{watch: selection.rect.Add(desktop.Min)}, nil
	}
	if selection.attach {
		return &desktopSnipResult{image: selection.screenshot(frame)}, nil
	}
	return nil, nil
}

func registerSelectionWindow(instance win.HINSTANCE) bool {
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
	return snipClassAtom != 0
}

func useSnipPhysicalPixels() func() {
	if setThreadDPI.Find() == nil {
		// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4) keeps mouse and bitmap coordinates in physical pixels.
		if previous, _, _ := setThreadDPI.Call(^uintptr(3)); previous != 0 {
			return func() { setThreadDPI.Call(previous) }
		}
	}
	return func() {}
}

func snipWindowProc(hwnd win.HWND, msg uint32, wParam, lParam uintptr) uintptr {
	value, ok := snipSelections.Load(win.GetCurrentThreadId())
	if !ok {
		return win.DefWindowProc(hwnd, msg, wParam, lParam)
	}
	s := value.(*desktopSelection)
	switch msg {
	case win.WM_ERASEBKGND:
		return 1
	case win.WM_PAINT:
		s.paint(hwnd)
		return 0
	case win.WM_LBUTTONDOWN:
		old := s.visualBounds()
		s.setHovered(hwnd, snipNone)
		point := s.mousePoint(lParam)
		s.pressed = s.actionAt(point)
		if s.pressed == snipNone {
			s.begin(point, s.px(7))
		}
		win.SetCapture(hwnd)
		s.redraw(hwnd, old)
		return 0
	case win.WM_MOUSEMOVE:
		point := s.mousePoint(lParam)
		if s.drag == snipDraw {
			s.updateStroke(hwnd, point)
		} else if s.drag != snipStill {
			old := s.visualBounds()
			s.update(point)
			s.redraw(hwnd, old)
		} else if s.pressed == snipNone {
			s.setHovered(hwnd, s.actionAt(point))
		}
		return 0
	case win.WM_MOUSELEAVE:
		s.setHovered(hwnd, snipNone)
		return 0
	case win.WM_TIMER:
		if wParam == snipHoverTimer {
			s.showTooltip(hwnd)
			return 0
		}
	case win.WM_LBUTTONUP:
		old := s.visualBounds()
		point := s.mousePoint(lParam)
		if s.drag != snipStill {
			s.update(point)
			s.drag = snipStill
		}
		action := s.pressed
		s.pressed = snipNone
		win.ReleaseCapture()
		if action != snipNone && action == s.actionAt(point) {
			s.runAction(hwnd, action)
		}
		s.setHovered(hwnd, s.actionAt(point))
		s.redraw(hwnd, old)
		return 0
	case win.WM_KEYDOWN:
		if s.keyDown(hwnd, wParam) {
			return 0
		}
	case win.WM_SETCURSOR:
		win.SetCursor(s.pointerCursor())
		return 1
	case win.WM_CAPTURECHANGED:
		old := s.visualBounds()
		s.drag = snipStill
		s.pressed = snipNone
		s.redraw(hwnd, old)
	case win.WM_KILLFOCUS:
		if !s.dialog {
			s.closed = true
		}
	case win.WM_RBUTTONDOWN, win.WM_CLOSE, win.WM_DISPLAYCHANGE:
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

func (s *desktopSelection) mousePoint(lParam uintptr) image.Point {
	// Mouse messages carry signed 16-bit client coordinates. Use the physical cursor on wider desktops.
	if s.bounds.Dx() > 32767 || s.bounds.Dy() > 32767 {
		return s.cursor()
	}
	return image.Pt(int(int16(lParam)), int(int16(lParam>>16)))
}

func (s *desktopSelection) setHint() {
	point := s.cursor()
	monitor := s.displayAt(point)
	s.hint = image.Rect(monitor.Min.X, monitor.Min.Y+s.px(22), monitor.Max.X, monitor.Min.Y+s.px(62))
}

func (s *desktopSelection) paint(hwnd win.HWND) {
	var paint win.PAINTSTRUCT
	dc := win.BeginPaint(hwnd, &paint)
	defer win.EndPaint(hwnd, &paint)
	r := paint.RcPaint
	s.paintBuffered(dc, image.Rect(int(r.Left), int(r.Top), int(r.Right), int(r.Bottom)))
}

// Paint only completed pixels to the window. A reusable tile limits memory on multi-monitor setups.
const snipPaintTile = 1024

func (s *desktopSelection) paintBuffered(dc win.HDC, dirty image.Rectangle) {
	for y := dirty.Min.Y; y < dirty.Max.Y; y += snipPaintTile {
		for x := dirty.Min.X; x < dirty.Max.X; x += snipPaintTile {
			area := image.Rect(x, y, min(x+snipPaintTile, dirty.Max.X), min(y+snipPaintTile, dirty.Max.Y))
			clip := toWinRect(area)
			saved := win.SaveDC(s.buffer.dc)
			if saved == 0 {
				return
			}
			win.SetViewportOrgEx(s.buffer.dc, -clip.Left, -clip.Top, nil)
			win.IntersectClipRect(s.buffer.dc, clip.Left, clip.Top, clip.Right, clip.Bottom)
			s.paintRegion(s.buffer.dc, area)
			win.RestoreDC(s.buffer.dc, saved)
			win.BitBlt(dc, clip.Left, clip.Top, clip.Right-clip.Left, clip.Bottom-clip.Top, s.buffer.dc, 0, 0, win.SRCCOPY)
		}
	}
}

func (s *desktopSelection) paintRegion(dc win.HDC, dirty image.Rectangle) {
	clip := toWinRect(dirty)
	win.BitBlt(dc, clip.Left, clip.Top, clip.Right-clip.Left, clip.Bottom-clip.Top, s.dim.dc, clip.Left, clip.Top, win.SRCCOPY)
	if !s.rect.Empty() {
		r := toWinRect(s.rect)
		win.BitBlt(dc, r.Left, r.Top, r.Right-r.Left, r.Bottom-r.Top, s.bright.dc, r.Left, r.Top, win.SRCCOPY)
		s.paintStrokes(dc, r)
		pen := win.SelectObject(dc, win.GetStockObject(win.WHITE_PEN))
		brush := win.SelectObject(dc, win.GetStockObject(win.NULL_BRUSH))
		win.Rectangle_(dc, r.Left, r.Top, r.Right, r.Bottom)
		win.SelectObject(dc, brush)
		win.SelectObject(dc, pen)
		s.paintSelectionTools(dc, dirty)
	} else if s.drag == snipStill {
		win.SetBkMode(dc, win.TRANSPARENT)
		win.SetTextColor(dc, win.RGB(255, 255, 255))
		hint := toWinRect(s.hint)
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
	bitmap, pixels, err := newScreenSurface(frame.Rect.Dx(), frame.Rect.Dy())
	if err != nil {
		return screenBitmap{}, err
	}
	copySnipPixels(pixels, frame, shade, false)
	return bitmap, nil
}

func newScreenSurface(width, height int) (screenBitmap, []byte, error) {
	bitmap := screenBitmap{dc: win.CreateCompatibleDC(0)}
	if bitmap.dc == 0 {
		return screenBitmap{}, nil, errors.New("无法创建截图画布")
	}
	var pixels unsafe.Pointer
	header := win.BITMAPINFOHEADER{
		BiWidth: int32(width), BiHeight: -int32(height),
		BiPlanes: 1, BiBitCount: 32, BiCompression: win.BI_RGB,
	}
	header.BiSize = uint32(unsafe.Sizeof(header))
	bitmap.bitmap = win.CreateDIBSection(bitmap.dc, &header, win.DIB_RGB_COLORS, &pixels, 0, 0)
	if bitmap.bitmap != 0 {
		bitmap.previous = win.SelectObject(bitmap.dc, win.HGDIOBJ(bitmap.bitmap))
	}
	if bitmap.previous == 0 || pixels == nil {
		bitmap.close()
		return screenBitmap{}, nil, errors.New("无法建立截图预览")
	}
	return bitmap, unsafe.Slice((*byte)(pixels), width*height*4), nil
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
