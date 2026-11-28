//go:build windows && !headless

package app

import (
	"errors"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"github.com/lxn/win"
	windowsAPI "golang.org/x/sys/windows"
)

type snipAction uint8

const (
	snipNone snipAction = iota
	snipCancel
	snipReselect
	snipAnnotate
	snipUndo
	snipPin
	snipCopy
	snipSave
	snipAttach
	snipWatch
)

var snipTools = [...]struct {
	action snipAction
	label  string
}{
	{snipCancel, "取消"},
	{snipReselect, "重新框选"},
	{snipAnnotate, "画笔标注"},
	{snipUndo, "撤销标注"},
	{snipPin, "置顶贴图"},
	{snipCopy, "复制图片"},
	{snipSave, "保存 PNG"},
	{snipAttach, "加入对话"},
	{snipWatch, "一起看"},
}

var snipCreatePen = windowsAPI.NewLazySystemDLL("gdi32.dll").NewProc("CreatePen")

func createSnipPen() win.HGDIOBJ {
	return createSnipColorPen(3, win.RGB(snipInk.R, snipInk.G, snipInk.B))
}

func createSnipColorPen(width int, color win.COLORREF) win.HGDIOBJ {
	pen, _, _ := snipCreatePen.Call(0, uintptr(width), uintptr(color))
	return win.HGDIOBJ(pen)
}

func (s *desktopSelection) px(dip int) int { return max(1, dip*s.dpi/96) }

func (s *desktopSelection) displayAt(point image.Point) image.Rectangle {
	for _, display := range s.displays {
		if point.In(display) {
			return display
		}
	}
	best, area := s.bounds, 0
	for _, display := range s.displays {
		part := display.Intersect(s.rect)
		if size := part.Dx() * part.Dy(); size > area {
			best, area = display, size
		}
	}
	return best
}

func (s *desktopSelection) selectionDisplay() image.Rectangle {
	center := s.rect.Min.Add(image.Pt(s.rect.Dx()/2, s.rect.Dy()/2))
	return s.displayAt(center)
}

func (s *desktopSelection) toolbarBounds() image.Rectangle {
	if s.rect.Empty() || s.drag == snipSelect || s.drag == snipMove || s.drag == snipResize {
		return image.Rectangle{}
	}
	return snipToolbarBounds(s.rect, s.selectionDisplay(), s.px(42), len(snipTools)*s.px(34)+2*s.px(4), s.px(8))
}

func (s *desktopSelection) toolRow(bar image.Rectangle, index int) image.Rectangle {
	pad := s.px(4)
	inner := bar.Inset(pad)
	top := inner.Min.Y + index*inner.Dy()/len(snipTools)
	bottom := inner.Min.Y + (index+1)*inner.Dy()/len(snipTools)
	return image.Rect(inner.Min.X, top, inner.Max.X, bottom)
}

func (s *desktopSelection) actionAt(point image.Point) snipAction {
	bar := s.toolbarBounds()
	if !point.In(bar) {
		return snipNone
	}
	for i, tool := range snipTools {
		if point.In(s.toolRow(bar, i)) {
			return tool.action
		}
	}
	return snipNone
}

func (s *desktopSelection) badgeBounds() image.Rectangle {
	display := s.selectionDisplay()
	w, h := min(s.px(128), display.Dx()), min(s.px(24), display.Dy())
	x := constrain((s.rect.Min.X+s.rect.Max.X-w)/2, display.Min.X, display.Max.X-w)
	y := s.rect.Min.Y - h - s.px(6)
	if y < display.Min.Y {
		y = s.rect.Min.Y + s.px(8)
	}
	y = constrain(y, display.Min.Y, display.Max.Y-h)
	return image.Rect(x, y, x+w, y+h)
}

func (s *desktopSelection) visualBounds() image.Rectangle {
	if s.rect.Empty() {
		return s.hint
	}
	return s.rect.Inset(-s.px(6)).Union(s.toolbarBounds()).Union(s.badgeBounds()).Union(s.tooltipBounds())
}

func (s *desktopSelection) redraw(hwnd win.HWND, old image.Rectangle) {
	invalidateSnip(hwnd, old.Union(s.visualBounds()))
}

func invalidateSnip(hwnd win.HWND, dirty image.Rectangle) {
	if !dirty.Empty() {
		r := toWinRect(dirty)
		win.InvalidateRect(hwnd, &r, false)
	}
}

func (s *desktopSelection) updateStroke(hwnd win.HWND, point image.Point) {
	i := len(s.strokes) - 1
	from := s.strokes[i][len(s.strokes[i])-1]
	s.update(point)
	to := s.strokes[i][len(s.strokes[i])-1]
	if from != to {
		dirty := image.Rect(min(from.X, to.X), min(from.Y, to.Y), max(from.X, to.X)+1, max(from.Y, to.Y)+1)
		invalidateSnip(hwnd, dirty.Inset(-3).Intersect(s.rect))
	}
}

const snipHoverTimer = 1

func (s *desktopSelection) setHovered(hwnd win.HWND, action snipAction) {
	if action == s.hovered {
		return
	}
	old := s.tooltipBounds()
	s.hovered, s.tooltip = action, snipNone
	win.KillTimer(hwnd, snipHoverTimer)
	if action != snipNone {
		track := win.TRACKMOUSEEVENT{DwFlags: win.TME_LEAVE, HwndTrack: hwnd}
		track.CbSize = uint32(unsafe.Sizeof(track))
		win.TrackMouseEvent(&track)
		win.SetTimer(hwnd, snipHoverTimer, 450, 0)
	}
	invalidateSnip(hwnd, old.Union(s.toolbarBounds()))
}

func (s *desktopSelection) showTooltip(hwnd win.HWND) {
	win.KillTimer(hwnd, snipHoverTimer)
	if s.drag == snipStill && s.pressed == snipNone {
		s.tooltip = s.hovered
		invalidateSnip(hwnd, s.tooltipBounds())
	}
}

func (s *desktopSelection) tooltipBounds() image.Rectangle {
	if s.tooltip == snipNone || s.drag != snipStill {
		return image.Rectangle{}
	}
	bar := s.toolbarBounds()
	if bar.Empty() {
		return image.Rectangle{}
	}
	row := s.toolRow(bar, int(s.tooltip-snipCancel))
	row.Min.X, row.Max.X = bar.Min.X, bar.Max.X
	return snipToolbarBounds(row, s.selectionDisplay(), s.px(92), s.px(28), s.px(6))
}

func (s *desktopSelection) pointerCursor() win.HCURSOR {
	point := s.cursor()
	cursor := win.IDC_CROSS
	edges := s.nearEdge(point, s.px(7))
	if s.drag == snipResize {
		edges = s.edges
	}
	switch {
	case s.drag == snipStill && point.In(s.toolbarBounds()):
		cursor = win.IDC_HAND
	case s.drag == snipMove:
		cursor = win.IDC_SIZEALL
	case s.drag == snipSelect || s.drag == snipDraw:
	case edges == snipLeft|snipTop || edges == snipRight|snipBottom:
		cursor = win.IDC_SIZENWSE
	case edges == snipRight|snipTop || edges == snipLeft|snipBottom:
		cursor = win.IDC_SIZENESW
	case edges&(snipLeft|snipRight) != 0:
		cursor = win.IDC_SIZEWE
	case edges&(snipTop|snipBottom) != 0:
		cursor = win.IDC_SIZENS
	case point.In(s.rect) && !s.pen:
		cursor = win.IDC_SIZEALL
	}
	return win.LoadCursor(0, (*uint16)(unsafe.Pointer(uintptr(cursor))))
}

func (s *desktopSelection) keyDown(hwnd win.HWND, key uintptr) bool {
	if key == win.VK_ESCAPE {
		s.closed = true
		return true
	}
	if s.rect.Empty() || s.drag != snipStill {
		return false
	}
	if key == win.VK_RETURN {
		s.runAction(hwnd, snipAttach)
		return true
	}
	if win.GetKeyState(win.VK_CONTROL) < 0 {
		switch key {
		case 'C':
			s.runAction(hwnd, snipCopy)
		case 'S':
			s.runAction(hwnd, snipSave)
		case 'Z':
			s.runAction(hwnd, snipUndo)
		default:
			return false
		}
		return true
	}
	return false
}

func (s *desktopSelection) runAction(hwnd win.HWND, action snipAction) {
	old := s.visualBounds()
	defer s.redraw(hwnd, old)
	if action == snipCancel {
		s.closed = true
		return
	}
	if s.rect.Empty() {
		return
	}
	var err error
	switch action {
	case snipReselect:
		s.snipSelection = snipSelection{bounds: s.bounds}
		s.setHint()
	case snipAnnotate:
		s.pen = !s.pen
	case snipUndo:
		if len(s.strokes) != 0 {
			s.strokes = s.strokes[:len(s.strokes)-1]
		}
	case snipPin:
		display := s.selectionDisplay().Add(s.desktop.Min)
		err = pinSnip(s.screenshot(s.frame), s.rect.Min.Add(s.desktop.Min), display, s.px(22))
		s.closed = err == nil
	case snipCopy:
		err = copySnip(hwnd, s.screenshot(s.frame))
		s.closed = err == nil
	case snipSave:
		s.dialog = true
		var saved bool
		saved, err = saveSnip(hwnd, func() image.Image { return s.screenshot(s.frame) })
		s.dialog = false
		s.closed = s.closed || saved
	case snipAttach:
		s.attach, s.closed = true, true
	case snipWatch:
		s.watch, s.closed = true, true
	}
	if err != nil && !s.closed {
		s.dialog = true
		win.MessageBox(hwnd, windowsAPI.StringToUTF16Ptr(err.Error()), snipTitle, win.MB_OK|win.MB_ICONERROR)
		s.dialog = false
	}
}

func (s *desktopSelection) paintSelectionTools(dc win.HDC, dirty image.Rectangle) {
	if s.drag == snipStill {
		for _, x := range []int{s.rect.Min.X, (s.rect.Min.X + s.rect.Max.X) / 2, s.rect.Max.X - 1} {
			for _, y := range []int{s.rect.Min.Y, (s.rect.Min.Y + s.rect.Max.Y) / 2, s.rect.Max.Y - 1} {
				if x == (s.rect.Min.X+s.rect.Max.X)/2 && y == (s.rect.Min.Y+s.rect.Max.Y)/2 {
					continue
				}
				p := image.Pt(x, y)
				handle := image.Rectangle{Min: p, Max: p.Add(image.Pt(1, 1))}.Inset(-s.px(3))
				if handle.Overlaps(dirty) {
					drawSnipTile(dc, handle, win.RGB(250, 250, 255), 2)
				}
			}
		}
	}
	badge := s.badgeBounds()
	if badge.Overlaps(dirty) {
		drawSnipTile(dc, badge, win.RGB(36, 31, 48), s.px(7))
		drawSnipLabel(dc, badge, fmt.Sprintf("%d × %d", s.rect.Dx(), s.rect.Dy()), win.RGB(255, 255, 255))
	}
	bar := s.toolbarBounds()
	if bar.Overlaps(dirty) {
		s.paintToolbar(dc, bar, dirty)
	}
	if tip := s.tooltipBounds(); tip.Overlaps(dirty) {
		drawSnipTile(dc, tip, win.RGB(36, 31, 48), s.px(7))
		drawSnipLabel(dc, tip, snipTools[int(s.tooltip-snipCancel)].label, win.RGB(255, 255, 255))
	}
}

func (s *desktopSelection) paintToolbar(dc win.HDC, bar, dirty image.Rectangle) {
	drawSnipTile(dc, bar, win.RGB(246, 243, 251), s.px(11))
	for i, tool := range snipTools {
		row := s.toolRow(bar, i)
		if !row.Overlaps(dirty) {
			continue
		}
		ink := win.RGB(42, 35, 55)
		switch {
		case tool.action == snipAttach:
			background := win.RGB(104, 66, 189)
			if s.hovered == tool.action || s.pressed == tool.action {
				background = win.RGB(82, 48, 161)
			}
			drawSnipTile(dc, row.Inset(1), background, s.px(7))
			ink = win.RGB(255, 255, 255)
		case tool.action == snipUndo && len(s.strokes) == 0:
			ink = win.RGB(145, 134, 157)
		case s.hovered == tool.action || s.pressed == tool.action || (tool.action == snipAnnotate && s.pen):
			drawSnipTile(dc, row.Inset(1), win.RGB(229, 216, 250), s.px(7))
		}
		drawSnipIcon(dc, row, tool.action, s.px(20), s.px(2), ink)
	}
}

// Paths use a shared 24-by-24 grid and scale with the native toolbar DPI.
var snipIconPaths = map[snipAction][][][2]int32{
	snipCancel:   {{{5, 5}, {19, 19}}, {{19, 5}, {5, 19}}},
	snipReselect: {{{3, 9}, {3, 3}, {9, 3}}, {{15, 3}, {21, 3}, {21, 9}}, {{21, 15}, {21, 21}, {15, 21}}, {{9, 21}, {3, 21}, {3, 15}}},
	snipAnnotate: {{{4, 15}, {15, 4}, {18, 4}, {20, 6}, {20, 9}, {9, 20}, {3, 21}, {4, 15}}, {{13, 6}, {18, 11}}},
	snipUndo:     {{{9, 4}, {3, 10}, {9, 16}}, {{3, 10}, {14, 10}, {18, 11}, {20, 14}, {20, 17}, {17, 20}, {12, 20}}},
	snipPin:      {{{7, 3}, {17, 3}, {15, 8}, {15, 12}, {19, 16}, {5, 16}, {9, 12}, {9, 8}, {7, 3}}, {{12, 16}, {12, 22}}},
	snipCopy:     {{{7, 7}, {20, 7}, {20, 21}, {7, 21}, {7, 7}}, {{4, 17}, {3, 17}, {3, 3}, {16, 3}, {16, 5}}},
	snipSave:     {{{4, 3}, {17, 3}, {21, 7}, {21, 21}, {3, 21}, {3, 3}, {4, 3}}, {{7, 3}, {7, 10}, {16, 10}, {16, 3}}, {{7, 21}, {7, 14}, {17, 14}, {17, 21}}},
	snipAttach:   {{{3, 4}, {21, 4}, {21, 17}, {10, 17}, {4, 21}, {4, 17}, {3, 17}, {3, 4}}, {{8, 10}, {16, 10}}, {{12, 6}, {12, 14}}},
	snipWatch:    {{{2, 12}, {7, 7}, {12, 5}, {17, 7}, {22, 12}, {17, 17}, {12, 19}, {7, 17}, {2, 12}}, {{12, 9}, {15, 12}, {12, 15}, {9, 12}, {12, 9}}},
}

func drawSnipIcon(dc win.HDC, rect image.Rectangle, action snipAction, size, width int, ink win.COLORREF) {
	pen := createSnipColorPen(width, ink)
	if pen == 0 {
		return
	}
	previous := win.SelectObject(dc, pen)
	defer func() {
		win.SelectObject(dc, previous)
		win.DeleteObject(pen)
	}()
	side := int32(min(size, rect.Dx(), rect.Dy()))
	x := int32(rect.Min.X) + (int32(rect.Dx())-side)/2
	y := int32(rect.Min.Y) + (int32(rect.Dy())-side)/2
	for _, path := range snipIconPaths[action] {
		points := make([]win.POINT, len(path))
		for i, p := range path {
			points[i] = win.POINT{X: x + p[0]*side/24, Y: y + p[1]*side/24}
		}
		win.Polyline(dc, unsafe.Pointer(&points[0]), int32(len(points)))
	}
}

func drawSnipTile(dc win.HDC, rect image.Rectangle, fill win.COLORREF, radius int) {
	r := toWinRect(rect)
	brush := win.CreateBrushIndirect(&win.LOGBRUSH{LbStyle: win.BS_SOLID, LbColor: fill})
	if brush == 0 {
		return
	}
	previousBrush := win.SelectObject(dc, win.HGDIOBJ(brush))
	previousPen := win.SelectObject(dc, win.GetStockObject(win.NULL_PEN))
	win.RoundRect(dc, r.Left, r.Top, r.Right, r.Bottom, int32(radius), int32(radius))
	win.SelectObject(dc, previousPen)
	win.SelectObject(dc, previousBrush)
	win.DeleteObject(win.HGDIOBJ(brush))
}

func drawSnipLabel(dc win.HDC, rect image.Rectangle, text string, ink win.COLORREF) {
	r := toWinRect(rect)
	win.SetBkMode(dc, win.TRANSPARENT)
	win.SetTextColor(dc, ink)
	win.DrawTextEx(dc, windowsAPI.StringToUTF16Ptr(text), -1, &r, win.DT_CENTER|win.DT_SINGLELINE|win.DT_VCENTER|win.DT_NOPREFIX, nil)
}

func (s *desktopSelection) paintStrokes(dc win.HDC, clip win.RECT) {
	if s.penHandle == 0 || len(s.strokes) == 0 {
		return
	}
	saved := win.SaveDC(dc)
	if saved == 0 {
		return
	}
	defer win.RestoreDC(dc, saved)
	win.IntersectClipRect(dc, clip.Left, clip.Top, clip.Right, clip.Bottom)
	win.SelectObject(dc, s.penHandle)
	for _, stroke := range s.strokes {
		points := make([]win.POINT, 0, max(2, len(stroke)))
		for _, p := range stroke {
			points = append(points, win.POINT{X: int32(p.X), Y: int32(p.Y)})
		}
		if len(points) == 1 {
			points = append(points, win.POINT{X: points[0].X + 1, Y: points[0].Y})
		}
		win.Polyline(dc, unsafe.Pointer(&points[0]), int32(len(points)))
	}
}

func copySnip(hwnd win.HWND, img *image.RGBA) error {
	bounds := img.Bounds()
	var header win.BITMAPINFOHEADER
	header.BiSize = uint32(unsafe.Sizeof(header))
	header.BiWidth, header.BiHeight = int32(bounds.Dx()), int32(bounds.Dy())
	header.BiPlanes, header.BiBitCount, header.BiCompression = 1, 32, win.BI_RGB
	size := int(header.BiSize) + bounds.Dx()*bounds.Dy()*4
	memory := win.GlobalAlloc(win.GMEM_MOVEABLE, uintptr(size))
	if memory == 0 {
		return errors.New("无法准备截图剪贴板数据")
	}
	owned := false
	defer func() {
		if !owned {
			win.GlobalFree(memory)
		}
	}()
	pointer := win.GlobalLock(memory)
	if pointer == nil {
		return errors.New("无法写入截图剪贴板数据")
	}
	*(*win.BITMAPINFOHEADER)(pointer) = header
	copySnipPixels(unsafe.Slice((*byte)(unsafe.Add(pointer, header.BiSize)), size-int(header.BiSize)), img, 0, true)
	win.GlobalUnlock(memory)
	if !win.OpenClipboard(hwnd) {
		return errors.New("剪贴板正在使用，请重试")
	}
	defer win.CloseClipboard()
	if !win.EmptyClipboard() || win.SetClipboardData(win.CF_DIB, win.HANDLE(memory)) == 0 {
		return errors.New("无法将截图复制到剪贴板")
	}
	owned = true
	return nil
}

func copySnipPixels(dest []byte, img *image.RGBA, shade uint, bottomUp bool) {
	width, height := img.Rect.Dx(), img.Rect.Dy()
	for y := range height {
		row := y
		if bottomUp {
			row = height - 1 - y
		}
		src, offset := y*img.Stride, row*width*4
		for range width {
			dest[offset], dest[offset+1], dest[offset+2], dest[offset+3] = img.Pix[src+2]>>shade, img.Pix[src+1]>>shade, img.Pix[src]>>shade, 0
			src, offset = src+4, offset+4
		}
	}
}

func saveSnip(hwnd win.HWND, screenshot func() image.Image) (bool, error) {
	file := make([]uint16, 32768)
	copy(file, windowsAPI.StringToUTF16("截图-"+time.Now().Format("20060102-150405")+".png"))
	filter := append(windowsAPI.StringToUTF16("PNG 图片 (*.png)"), windowsAPI.StringToUTF16("*.png")...)
	filter = append(filter, 0)
	dialog := win.OPENFILENAME{
		HwndOwner: hwnd, LpstrFilter: &filter[0], LpstrFile: &file[0], NMaxFile: uint32(len(file)),
		LpstrTitle: windowsAPI.StringToUTF16Ptr("保存截图"), LpstrDefExt: windowsAPI.StringToUTF16Ptr("png"),
		Flags: win.OFN_EXPLORER | win.OFN_OVERWRITEPROMPT | win.OFN_NOCHANGEDIR | win.OFN_PATHMUSTEXIST,
	}
	dialog.LStructSize = uint32(unsafe.Sizeof(dialog))
	if !win.GetSaveFileName(&dialog) {
		if win.CommDlgExtendedError() != 0 {
			return false, errors.New("无法打开截图保存窗口")
		}
		return false, nil
	}
	path := windowsAPI.UTF16ToString(file)
	if !strings.EqualFold(filepath.Ext(path), ".png") {
		return false, errors.New("请为截图选择 .png 文件名")
	}
	if err := writeSnipPNG(path, screenshot()); err != nil {
		return false, errors.New("无法保存截图，请检查目标位置并重试")
	}
	return true, nil
}

func writeSnipPNG(path string, img image.Image) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".live2d-snip-*.png")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	err = errors.Join(png.Encode(temporary, img), temporary.Close())
	if err != nil {
		return err
	}
	return os.Rename(name, path)
}
