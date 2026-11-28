//go:build windows && !headless

package app

import (
	"image"
	"image/color"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"

	"github.com/lxn/win"
)

func TestSnipMouseReleaseKeepsNativeToolbarOpen(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	bounds := image.Rect(0, 0, 1000, 800)
	s := &desktopSelection{
		snipSelection: snipSelection{bounds: bounds},
		desktop:       bounds, displays: []image.Rectangle{bounds}, dpi: 96,
	}
	thread := win.GetCurrentThreadId()
	snipSelections.Store(thread, s)
	defer snipSelections.Delete(thread)
	instance := win.GetModuleHandle(nil)
	if !registerSelectionWindow(instance) {
		t.Fatal("unable to register native capture window")
	}
	// The window stays hidden and receives a synthetic drag. No desktop pixels are read.
	hwnd := win.CreateWindowEx(win.WS_EX_TOOLWINDOW, snipClass, snipTitle, win.WS_POPUP,
		0, 0, 1000, 800, 0, 0, instance, nil)
	if hwnd == 0 {
		t.Fatal("unable to create native capture window")
	}
	defer win.DestroyWindow(hwnd)
	point := func(x, y int) uintptr { return uintptr(uint16(x)) | uintptr(uint16(y))<<16 }
	win.SendMessage(hwnd, win.WM_LBUTTONDOWN, 0, point(100, 140))
	win.SendMessage(hwnd, win.WM_MOUSEMOVE, 0, point(440, 465))
	win.SendMessage(hwnd, win.WM_LBUTTONUP, 0, point(450, 470))
	if s.closed || s.attach || s.rect != image.Rect(100, 140, 450, 470) {
		t.Fatalf("release should keep the selection open: rect %v, closed %v, attach %v", s.rect, s.closed, s.attach)
	}
	bar := s.toolbarBounds()
	if bar.Empty() || bar.Min.X <= s.rect.Max.X {
		t.Fatalf("toolbar should be visible to the right: %v", bar)
	}
	annotate := s.toolRow(bar, int(snipAnnotate-snipCancel))
	win.SendMessage(hwnd, win.WM_MOUSEMOVE, 0, point(annotate.Min.X+4, annotate.Min.Y+4))
	if s.hovered != snipAnnotate || !s.tooltipBounds().Empty() {
		t.Fatal("the annotation icon should highlight immediately and wait before showing its label")
	}
	win.SendMessage(hwnd, win.WM_TIMER, snipHoverTimer, 0)
	if tip := s.tooltipBounds(); tip.Empty() || tip.Overlaps(bar) {
		t.Fatalf("the hovered tool should show its label beside the toolbar: %v", tip)
	}
	win.SendMessage(hwnd, win.WM_MOUSELEAVE, 0, 0)
	if !s.tooltipBounds().Empty() {
		t.Fatal("hover label should close when the pointer leaves")
	}
	attach := s.toolRow(bar, int(snipAttach-snipCancel))
	click := point(attach.Min.X+4, attach.Min.Y+4)
	win.SendMessage(hwnd, win.WM_LBUTTONDOWN, 0, click)
	win.SendMessage(hwnd, win.WM_LBUTTONUP, 0, click)
	if !s.closed || !s.attach {
		t.Fatal("explicit attachment action should complete the selection")
	}
	s.closed, s.attach = false, false
	watch := s.toolRow(bar, int(snipWatch-snipCancel))
	click = point(watch.Min.X+4, watch.Min.Y+4)
	win.SendMessage(hwnd, win.WM_LBUTTONDOWN, 0, click)
	win.SendMessage(hwnd, win.WM_LBUTTONUP, 0, click)
	if !s.closed || !s.watch || s.attach {
		t.Fatal("watching should retain the selected area without attaching a screenshot")
	}
}

func TestSnipBufferedPaintComposesBackgroundAndInkAcrossTiles(t *testing.T) {
	bounds := image.Rect(0, 0, snipPaintTile+120, 180)
	frame := image.NewRGBA(bounds)
	for y := range bounds.Dy() {
		for x := range bounds.Dx() {
			frame.SetRGBA(x, y, color.RGBA{R: 160, G: 120, B: 80, A: 255})
		}
	}
	bright, err := newScreenBitmap(frame, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer bright.close()
	dim, err := newScreenBitmap(frame, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer dim.close()
	buffer, _, err := newScreenSurface(snipPaintTile, bounds.Dy())
	if err != nil {
		t.Fatal(err)
	}
	defer buffer.close()
	target, _, err := newScreenSurface(bounds.Dx(), bounds.Dy())
	if err != nil {
		t.Fatal(err)
	}
	defer target.close()
	pen := createSnipPen()
	defer win.DeleteObject(pen)
	s := desktopSelection{
		snipSelection: snipSelection{
			bounds: bounds, rect: image.Rect(800, 40, 1140, 160), drag: snipDraw,
			strokes: [][]image.Point{{image.Pt(960, 80), image.Pt(1120, 80)}},
		},
		bright: bright, dim: dim, buffer: buffer, penHandle: pen,
		displays: []image.Rectangle{bounds}, dpi: 96,
	}
	s.paintBuffered(target.dc, bounds)
	for _, sample := range []struct {
		p    image.Point
		want win.COLORREF
	}{
		{image.Pt(500, 90), win.RGB(80, 60, 40)},
		{image.Pt(840, 90), win.RGB(160, 120, 80)},
		{image.Pt(1000, 80), win.RGB(snipInk.R, snipInk.G, snipInk.B)},
		{image.Pt(1040, 80), win.RGB(snipInk.R, snipInk.G, snipInk.B)},
		{image.Pt(1100, 90), win.RGB(160, 120, 80)},
	} {
		if got := win.GetPixel(target.dc, int32(sample.p.X), int32(sample.p.Y)); got != sample.want {
			t.Fatalf("buffered pixel %v: got %#x, want %#x", sample.p, got, sample.want)
		}
	}
}

func TestSnipExportHandlesCroppedBitmapStride(t *testing.T) {
	frame := image.NewRGBA(image.Rect(0, 0, 4, 4))
	frame.SetRGBA(1, 1, color.RGBA{R: 7, G: 8, B: 9, A: 255})
	frame.SetRGBA(1, 2, color.RGBA{R: 1, G: 2, B: 3, A: 255})
	snip := frame.SubImage(image.Rect(1, 1, 2, 3)).(*image.RGBA)
	bits := make([]byte, 8)
	copySnipPixels(bits, snip, 0, true)
	if want := []byte{3, 2, 1, 0, 9, 8, 7, 0}; !slices.Equal(bits, want) {
		t.Fatalf("clipboard pixel data %v; want %v", bits, want)
	}
	path := filepath.Join(t.TempDir(), "target.png")
	if err := writeSnipPNG(path, snip); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	decoded, format, err := image.Decode(file)
	if err != nil || format != "png" || decoded.Bounds().Size() != image.Pt(1, 2) {
		t.Fatalf("exported PNG %s %v", format, err)
	}
}
