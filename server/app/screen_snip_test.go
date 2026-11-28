package app

import (
	"encoding/base64"
	"image"
	"image/color"
	"math/rand/v2"
	"strings"
	"testing"
)

func TestEncodeScreenSnipKeepsSelectedPixels(t *testing.T) {
	frame := image.NewRGBA(image.Rect(0, 0, 12, 10))
	selected := image.Rect(3, 2, 8, 9)
	pixel := color.RGBA{R: 123, G: 65, B: 92, A: 255}
	frame.SetRGBA(3, 2, pixel)
	shot, err := encodeScreenSnip(frame.SubImage(selected))
	if err != nil {
		t.Fatal(err)
	}
	decoded, format := decodeScreenSnip(t, shot)
	if format != "png" || shot.Width != 5 || shot.Height != 7 || color.RGBAModel.Convert(decoded.At(0, 0)) != pixel {
		t.Fatalf("unexpected crop: %s %dx%d %+v", format, shot.Width, shot.Height, decoded.At(0, 0))
	}
}

func TestEncodeScreenSnipFitsChatLimit(t *testing.T) {
	frame := image.NewRGBA(image.Rect(0, 0, 1900, 1200))
	random := rand.New(rand.NewPCG(73, 83))
	for i := 0; i < len(frame.Pix); i += 4 {
		value := random.Uint32()
		frame.Pix[i], frame.Pix[i+1], frame.Pix[i+2], frame.Pix[i+3] = byte(value), byte(value>>8), byte(value>>16), 255
	}
	shot, err := encodeScreenSnip(frame)
	if err != nil {
		t.Fatal(err)
	}
	decoded, format := decodeScreenSnip(t, shot)
	if format != "jpeg" || decoded.Bounds().Dx() != shot.Width || decoded.Bounds().Dy() != shot.Height {
		t.Fatalf("unexpected attachment: %s %dx%d", format, shot.Width, shot.Height)
	}
}

func decodeScreenSnip(t *testing.T, shot *screenSnip) (image.Image, string) {
	t.Helper()
	_, payload, ok := strings.Cut(shot.Image, ";base64,")
	if !ok || len(payload) > base64.StdEncoding.EncodedLen(maxSnipImageBytes) {
		t.Fatal("screenshot is not a supported attachment data URL")
	}
	decoded, format, err := image.Decode(base64.NewDecoder(base64.StdEncoding, strings.NewReader(payload)))
	if err != nil {
		t.Fatal(err)
	}
	return decoded, format
}
