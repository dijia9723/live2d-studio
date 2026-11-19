package app

import (
	"image"
	"image/color"
	"image/draw"
)

type snipDrag uint8

const (
	snipStill snipDrag = iota
	snipSelect
	snipMove
	snipResize
	snipDraw
)

type snipEdge uint8

const (
	snipLeft snipEdge = 1 << iota
	snipRight
	snipTop
	snipBottom
)

var snipInk = color.RGBA{R: 231, G: 51, B: 73, A: 255}

type snipSelection struct {
	bounds, rect, initial image.Rectangle
	anchor                image.Point
	drag                  snipDrag
	edges                 snipEdge
	pen                   bool
	strokes               [][]image.Point
}

func (s *snipSelection) nearEdge(point image.Point, radius int) snipEdge {
	if s.rect.Empty() || !point.In(s.rect.Inset(-radius)) {
		return 0
	}
	x := min(radius, max(1, s.rect.Dx()/3))
	y := min(radius, max(1, s.rect.Dy()/3))
	var edges snipEdge
	if point.X <= s.rect.Min.X+x {
		edges |= snipLeft
	} else if point.X >= s.rect.Max.X-x {
		edges |= snipRight
	}
	if point.Y <= s.rect.Min.Y+y {
		edges |= snipTop
	} else if point.Y >= s.rect.Max.Y-y {
		edges |= snipBottom
	}
	return edges
}

func (s *snipSelection) begin(point image.Point, radius int) {
	s.anchor, s.initial = point, s.rect
	s.edges = s.nearEdge(point, radius)
	switch {
	case s.edges != 0:
		s.drag = snipResize
	case point.In(s.rect) && s.pen:
		s.drag = snipDraw
		s.strokes = append(s.strokes, []image.Point{point})
	case point.In(s.rect):
		s.drag = snipMove
	default:
		s.drag = snipSelect
		s.rect = image.Rectangle{}
		s.strokes = nil
		s.pen = false
	}
}

func (s *snipSelection) update(point image.Point) {
	delta := point.Sub(s.anchor)
	switch s.drag {
	case snipSelect:
		s.rect = image.Rect(s.anchor.X, s.anchor.Y, point.X, point.Y).Intersect(s.bounds)
	case snipMove:
		delta.X = constrain(delta.X, s.bounds.Min.X-s.initial.Min.X, s.bounds.Max.X-s.initial.Max.X)
		delta.Y = constrain(delta.Y, s.bounds.Min.Y-s.initial.Min.Y, s.bounds.Max.Y-s.initial.Max.Y)
		s.rect = s.initial.Add(delta)
	case snipResize:
		r := s.initial
		if s.edges&snipLeft != 0 {
			r.Min.X = constrain(r.Min.X+delta.X, s.bounds.Min.X, r.Max.X-1)
		}
		if s.edges&snipRight != 0 {
			r.Max.X = constrain(r.Max.X+delta.X, r.Min.X+1, s.bounds.Max.X)
		}
		if s.edges&snipTop != 0 {
			r.Min.Y = constrain(r.Min.Y+delta.Y, s.bounds.Min.Y, r.Max.Y-1)
		}
		if s.edges&snipBottom != 0 {
			r.Max.Y = constrain(r.Max.Y+delta.Y, r.Min.Y+1, s.bounds.Max.Y)
		}
		s.rect = r
	case snipDraw:
		point.X = constrain(point.X, s.rect.Min.X, s.rect.Max.X-1)
		point.Y = constrain(point.Y, s.rect.Min.Y, s.rect.Max.Y-1)
		i := len(s.strokes) - 1
		if stroke := s.strokes[i]; point != stroke[len(stroke)-1] {
			s.strokes[i] = append(stroke, point)
		}
	}
}

func constrain(value, low, high int) int { return max(low, min(value, high)) }

// The toolbar stays on the display containing the selection, including when the window spans multiple monitors.
func snipToolbarBounds(selection, display image.Rectangle, width, height, gap int) image.Rectangle {
	width, height = min(width, display.Dx()), min(height, display.Dy())
	x := selection.Max.X + gap
	if x+width > display.Max.X {
		x = selection.Min.X - gap - width
		if x < display.Min.X {
			x = selection.Max.X - gap - width
		}
	}
	x = constrain(x, display.Min.X, display.Max.X-width)
	y := constrain(selection.Max.Y-height, display.Min.Y, display.Max.Y-height)
	return image.Rect(x, y, x+width, y+height)
}

func (s *snipSelection) screenshot(frame *image.RGBA) *image.RGBA {
	if len(s.strokes) == 0 {
		return frame.SubImage(s.rect).(*image.RGBA)
	}
	out := image.NewRGBA(s.rect)
	draw.Draw(out, s.rect, frame, s.rect.Min, draw.Src)
	for _, stroke := range s.strokes {
		previous := stroke[0]
		for _, point := range stroke {
			paintSnipLine(out, previous, point)
			previous = point
		}
	}
	return out
}

func paintSnipLine(img *image.RGBA, from, to image.Point) {
	dx, dy := absSnip(to.X-from.X), -absSnip(to.Y-from.Y)
	sx, sy := 1, 1
	if from.X > to.X {
		sx = -1
	}
	if from.Y > to.Y {
		sy = -1
	}
	err := dx + dy
	for {
		for y := from.Y - 1; y <= from.Y+1; y++ {
			for x := from.X - 1; x <= from.X+1; x++ {
				img.SetRGBA(x, y, snipInk)
			}
		}
		if from == to {
			return
		}
		step := 2 * err
		if step >= dy {
			err += dy
			from.X += sx
		}
		if step <= dx {
			err += dx
			from.Y += sy
		}
	}
}

func absSnip(value int) int { return max(value, -value) }
