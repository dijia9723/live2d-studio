//go:build windows && !headless

package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"hash/crc32"
	"image"
	"image/jpeg"
	"runtime"

	"github.com/kbinani/screenshot"
	"github.com/lxn/win"
)

type screenWatch struct {
	id       string
	bounds   image.Rectangle
	hasFrame bool
	checksum uint32
}

type watchPointer struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type screenWatchFrame struct {
	Image   string        `json:"image,omitempty"`
	Pointer *watchPointer `json:"pointer,omitempty"`
}

// WatchFrame only reads the desktop rectangle the user selected in the native overlay.
func (s *ScreenCapture) WatchFrame(ctx context.Context, id string) (*screenWatchFrame, error) {
	s.watchMu.Lock()
	defer s.watchMu.Unlock()
	watch := s.watch
	if watch == nil || watch.id != id {
		return nil, errors.New("观看已结束")
	}
	if s.busy.Load() || ctx.Err() != nil {
		return nil, nil
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer useSnipPhysicalPixels()()
	result := &screenWatchFrame{}
	var cursor win.POINT
	if win.GetCursorPos(&cursor) {
		point := image.Pt(int(cursor.X), int(cursor.Y))
		if point.In(watch.bounds) {
			offset := point.Sub(watch.bounds.Min)
			result.Pointer = &watchPointer{
				X: float64(offset.X) / float64(watch.bounds.Dx()),
				Y: float64(offset.Y) / float64(watch.bounds.Dy()),
			}
		}
	}
	frame, err := screenshot.CaptureRect(watch.bounds)
	if err != nil {
		return nil, errors.New("无法读取正在观看的屏幕区域")
	}
	checksum := crc32.ChecksumIEEE(frame.Pix)
	if watch.hasFrame && watch.checksum == checksum {
		return result, nil
	}
	var output bytes.Buffer
	if err := jpeg.Encode(&output, fitScreenSnip(frame, 1600), &jpeg.Options{Quality: 88}); err != nil {
		return nil, err
	}
	watch.checksum, watch.hasFrame = checksum, true
	result.Image = "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(output.Bytes())
	return result, nil
}

func (s *ScreenCapture) EndWatch(id string) {
	s.watchMu.Lock()
	defer s.watchMu.Unlock()
	if s.watch != nil && s.watch.id == id {
		s.watch = nil
	}
}
