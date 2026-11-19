package app

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
)

type screenSnip struct {
	Image  string `json:"image"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

const maxSnipImageBytes = 4 << 20 // Same limit as the chat image attachment.

type snipBuffer struct{ bytes.Buffer }

func (b *snipBuffer) Write(p []byte) (int, error) {
	if len(p) > maxSnipImageBytes-b.Len() {
		return 0, errors.New("截图超过附件大小限制")
	}
	return b.Buffer.Write(p)
}

func encodeScreenSnip(img image.Image) (*screenSnip, error) {
	var output snipBuffer
	result := func(media string, bounds image.Rectangle) *screenSnip {
		return &screenSnip{
			Image: "data:" + media + ";base64," + base64.StdEncoding.EncodeToString(output.Bytes()),
			Width: bounds.Dx(), Height: bounds.Dy(),
		}
	}
	encoder := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := encoder.Encode(&output, img); err == nil {
		return result("image/png", img.Bounds()), nil
	}
	for size := 3200; size >= 400; size /= 2 {
		output.Reset()
		candidate := fitScreenSnip(img, size)
		if err := jpeg.Encode(&output, candidate, &jpeg.Options{Quality: 86}); err == nil {
			return result("image/jpeg", candidate.Bounds()), nil
		}
	}
	return nil, errors.New("无法将截图压缩到附件大小限制，请截取较小的区域")
}

func fitScreenSnip(src image.Image, maxSide int) image.Image {
	bounds := src.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	longest := max(width, height)
	if longest <= maxSide {
		return src
	}
	w := max(1, width*maxSide/longest)
	h := max(1, height*maxSide/longest)
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			out.Set(x, y, src.At(bounds.Min.X+x*width/w, bounds.Min.Y+y*height/h))
		}
	}
	return out
}
