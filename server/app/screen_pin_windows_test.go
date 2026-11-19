//go:build windows && !headless

package app

import (
	"image"
	"image/color"
	"runtime"
	"slices"
	"testing"
	"unsafe"

	"github.com/lxn/win"
	windowsAPI "golang.org/x/sys/windows"
)

func TestPinnedSnipRightClickKeepsWindowAndTopmostCanToggle(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	instance := win.GetModuleHandle(nil)
	if !registerPinnedSnipWindow(instance) {
		t.Fatal("unable to register native pin window")
	}
	img := image.NewRGBA(image.Rect(0, 0, 64, 64))
	pin := &pinnedSnip{imageArea: image.Rect(8, 8, 72, 72)}
	thread := win.GetCurrentThreadId()
	pinnedSnips.Store(thread, pin)
	defer pinnedSnips.Delete(thread)
	hwnd := win.CreateWindowEx(win.WS_EX_TOPMOST|win.WS_EX_TOOLWINDOW|win.WS_EX_LAYERED, snipPinClass, snipPinTitle,
		win.WS_POPUP, 0, 0, 80, 80, 0, 0, instance, nil)
	if hwnd == 0 {
		t.Fatal("unable to create hidden pin window")
	}
	defer win.DestroyWindow(hwnd)
	if err := presentPinnedSnip(hwnd, img, 8); err != nil {
		t.Fatal(err)
	}

	point := pinMenuCoordinates(win.POINT{X: 25, Y: 30})
	if got := win.SendMessage(hwnd, win.WM_NCHITTEST, 0, point); got != win.HTCLIENT {
		t.Fatalf("the image should receive normal mouse events, got hit-test %d", got)
	}
	if got := win.SendMessage(hwnd, win.WM_NCHITTEST, 0, pinMenuCoordinates(win.POINT{X: 6, Y: 36})); int(got) != win.HTTRANSPARENT {
		t.Fatalf("the shadow should stay out of the image hit area, got hit-test %d", got)
	}
	for _, message := range []uint32{win.WM_RBUTTONUP, win.WM_NCRBUTTONUP} {
		win.SendMessage(hwnd, message, 0, point)
		var request win.MSG
		if !win.PeekMessage(&request, hwnd, win.WM_CONTEXTMENU, win.WM_CONTEXTMENU, win.PM_REMOVE) ||
			request.WParam != uintptr(hwnd) || request.LParam != point {
			t.Fatalf("right click message %d did not queue the menu at the mouse position", message)
		}
		win.DispatchMessage(&request)
		if pin.closed {
			t.Fatal("right click closed the pin")
		}
	}
	if !pinnedSnipIsTopmost(hwnd) {
		t.Fatal("new pin should be topmost")
	}
	for _, want := range []bool{false, true} {
		if err := pin.runMenuCommand(hwnd, pinToggleTopmost); err != nil {
			t.Fatal(err)
		}
		if pinnedSnipIsTopmost(hwnd) != want || pin.closed {
			t.Fatalf("topmost: expected %v, pin closed: %v", want, pin.closed)
		}
	}
	if err := pin.runMenuCommand(hwnd, 0); err != nil || pin.closed {
		t.Fatal("dismissed menu changed the pin")
	}
	if err := pin.runMenuCommand(hwnd, pinDelete); err != nil || !pin.closed {
		t.Fatal("explicit delete should close the pin")
	}
}

func TestPinnedSnipShadowSoftensOutsideOriginalPixels(t *testing.T) {
	frame := image.NewRGBA(image.Rect(0, 0, 40, 40))
	originalPixel := color.RGBA{R: 71, G: 123, B: 205, A: 255}
	frame.SetRGBA(5, 7, originalPixel)
	img := frame.SubImage(image.Rect(5, 7, 21, 23)).(*image.RGBA)
	const padding = 22
	width := img.Rect.Dx() + 2*padding
	height := img.Rect.Dy() + 2*padding
	pixels := make([]byte, width*height*4)
	paintPinShadow(pixels, img, padding)
	pixel := func(x, y int) []byte { return pixels[(y*width+x)*4:][:4] }
	if got := pixel(padding, padding); !slices.Equal(got, []byte{205, 123, 71, 255}) {
		t.Fatalf("image pixel changed: %v", got)
	}
	x := width / 2
	bottom := padding + img.Rect.Dy()
	if pixel(x, bottom)[3] <= pixel(x, padding-1)[3] || pixel(x, bottom+6)[3] <= pixel(x, bottom+12)[3] || pixel(x, height-1)[3] != 0 {
		t.Fatal("shadow should be strongest below the image and fade to transparent")
	}
	if frame.RGBAAt(5, 7) != originalPixel || frame.RGBAAt(21, 23).A != 0 {
		t.Fatal("painting the shadow modified the source capture")
	}
}

func TestPinnedSnipNativeMenuIncludesActionsAndTopmostState(t *testing.T) {
	for _, topmost := range []bool{true, false} {
		menu := makePinnedSnipMenu(topmost)
		if menu == 0 {
			t.Fatal("unable to create native pin menu")
		}
		defer win.DestroyMenu(menu)
		if count := win.GetMenuItemCount(menu); count != 5 {
			t.Fatalf("menu has %d items, want four actions and one separator", count)
		}
		for id, want := range map[uint32]string{pinCopy: "复制图片", pinSave: "保存 PNG", pinToggleTopmost: "置顶", pinDelete: "删除贴图"} {
			var label [40]uint16
			info := win.MENUITEMINFO{FMask: win.MIIM_STRING | win.MIIM_STATE, DwTypeData: &label[0], Cch: uint32(len(label))}
			info.CbSize = uint32(unsafe.Sizeof(info))
			if !win.GetMenuItemInfo(menu, id, 0, &info) || windowsAPI.UTF16ToString(label[:]) != want {
				t.Fatalf("missing menu action %q", want)
			}
			if checked := info.FState&win.MFS_CHECKED != 0; checked != (id == pinToggleTopmost && topmost) {
				t.Fatalf("unexpected check state for %q: %v", want, checked)
			}
		}
	}
}
