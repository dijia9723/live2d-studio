package app

import (
	"image"
	"image/color"
	"testing"
)

func TestSnipToolbarPlacement(t *testing.T) {
	display := image.Rect(-1200, 40, 0, 840)
	for _, tc := range []struct {
		label           string
		selection, want image.Rectangle
	}{
		{"right", image.Rect(-1100, 150, -650, 550), image.Rect(-642, 296, -536, 550)},
		{"left at right edge", image.Rect(-480, 100, -4, 310), image.Rect(-594, 56, -488, 310)},
		{"inside fullscreen", display, image.Rect(-114, 586, -8, 840)},
	} {
		t.Run(tc.label, func(t *testing.T) {
			if got := snipToolbarBounds(tc.selection, display, 106, 254, 8); got != tc.want {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestSnipSelectionCanMoveResizeAndExportMarks(t *testing.T) {
	s := snipSelection{bounds: image.Rect(0, 0, 100, 100)}
	s.begin(image.Pt(70, 60), 6)
	s.update(image.Pt(20, 20))
	if want := image.Rect(20, 20, 70, 60); s.rect != want {
		t.Fatalf("reversed drag: got %v, want %v", s.rect, want)
	}
	s.begin(image.Pt(40, 42), 6)
	s.update(image.Pt(97, 95))
	if want := image.Rect(50, 60, 100, 100); s.drag != snipMove || s.rect != want {
		t.Fatalf("bounded move: drag %v, rect %v", s.drag, s.rect)
	}
	s.begin(image.Pt(50, 80), 6)
	s.update(image.Pt(63, 80))
	if want := image.Rect(63, 60, 100, 100); s.drag != snipResize || s.rect != want {
		t.Fatalf("resize left edge: drag %v, rect %v", s.drag, s.rect)
	}
	s.pen = true
	s.begin(image.Pt(75, 75), 6)
	s.update(image.Pt(140, 90))
	frame := image.NewRGBA(s.bounds)
	original := color.RGBA{R: 50, G: 100, B: 200, A: 255}
	frame.SetRGBA(75, 75, original)
	cropped := s.screenshot(frame)
	if s.drag != snipDraw || cropped.Bounds() != s.rect || cropped.RGBAAt(75, 75) != snipInk || cropped.RGBAAt(99, 90) != snipInk {
		t.Fatalf("annotation not exported within the selection: %v %v", s.drag, cropped.Bounds())
	}
	if frame.RGBAAt(75, 75) != original {
		t.Fatal("annotation changed the frozen desktop pixels")
	}
}
