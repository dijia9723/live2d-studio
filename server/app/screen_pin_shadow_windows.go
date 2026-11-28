//go:build windows && !headless

package app

import (
	"errors"
	"image"
	"unsafe"

	"github.com/lxn/win"
	windowsAPI "golang.org/x/sys/windows"
)

var updatePinLayer = windowsAPI.NewLazySystemDLL("user32.dll").NewProc("UpdateLayeredWindow")

func presentPinnedSnip(hwnd win.HWND, img *image.RGBA, padding int) error {
	width := img.Rect.Dx() + 2*padding
	height := img.Rect.Dy() + 2*padding
	bitmap, pixels, err := newScreenSurface(width, height)
	if err != nil {
		return err
	}
	defer bitmap.close()
	paintPinShadow(pixels, img, padding)

	size := win.SIZE{CX: int32(width), CY: int32(height)}
	source := win.POINT{}
	blend := win.BLENDFUNCTION{AlphaFormat: win.AC_SRC_ALPHA, SourceConstantAlpha: 255}
	const ulwAlpha = 2
	ok, _, _ := updatePinLayer.Call(uintptr(hwnd), 0, 0, uintptr(unsafe.Pointer(&size)), uintptr(bitmap.dc),
		uintptr(unsafe.Pointer(&source)), 0, uintptr(unsafe.Pointer(&blend)), ulwAlpha)
	if ok == 0 {
		return errors.New("无法显示带阴影的贴图")
	}
	return nil
}

// The DIB uses premultiplied BGRA. The shadow is black, so only its alpha channel needs to be blended.
func paintPinShadow(pixels []byte, img *image.RGBA, padding int) {
	width := img.Rect.Dx() + 2*padding
	height := img.Rect.Dy() + 2*padding
	content := image.Rect(padding, padding, width-padding, height-padding)
	shift := padding / 5
	shadow := content.Add(image.Pt(0, shift))
	radius := max(1, padding-shift-1)
	falloff := make([]int, radius+1)
	for d := range falloff {
		falloff[d] = 255 * (radius - d) * (radius - d) / (radius * radius)
	}
	for y := range height {
		dy := min(radius, max(0, shadow.Min.Y-y, y-shadow.Max.Y+1))
		for x := range width {
			offset := (y*width + x) * 4
			if image.Pt(x, y).In(content) {
				src := (y-content.Min.Y)*img.Stride + (x-content.Min.X)*4
				pixels[offset], pixels[offset+1], pixels[offset+2], pixels[offset+3] =
					img.Pix[src+2], img.Pix[src+1], img.Pix[src], img.Pix[src+3]
				continue
			}
			dx := min(radius, max(0, shadow.Min.X-x, x-shadow.Max.X+1))
			pixels[offset], pixels[offset+1], pixels[offset+2] = 0, 0, 0
			pixels[offset+3] = byte(125 * falloff[dx] * falloff[dy] / (255 * 255))
		}
	}
}
