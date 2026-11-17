package sceneassets

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"server/internal/model"
)

const (
	ImageLimit int64 = 15 << 20
	VideoLimit int64 = 150 << 20
)

var (
	ErrUnsupported = errors.New("请选择 PNG、JPEG、WebP、GIF 图片或 MP4、WebM 视频")
	ErrTooLarge    = errors.New("图片最大 15MB，视频最大 150MB")
)

type Service struct {
	DB       *gorm.DB
	MediaDir string
}

func (s *Service) List(ctx context.Context) ([]model.SceneAsset, error) {
	result := []model.SceneAsset{}
	err := s.DB.WithContext(ctx).Order("created_at desc, rowid desc").Find(&result).Error
	for i := range result {
		result[i].URL = mediaURL(result[i].Filename)
	}
	return result, err
}

func mediaURL(name string) string { return "/scene-media/" + name }

func mediaType(header []byte) (kind, mime, extension string) {
	mime = http.DetectContentType(header)
	switch mime {
	case "image/png":
		return "image", mime, ".png"
	case "image/jpeg":
		return "image", mime, ".jpg"
	case "image/webp":
		return "image", mime, ".webp"
	case "image/gif":
		return "image", mime, ".gif"
	case "video/mp4":
		return "video", mime, ".mp4"
	case "video/webm":
		// The EBML magic is also used by Matroska. Require the WebM
		// DocType element as well so an arbitrary MKV is not accepted.
		if bytes.Contains(header, []byte{0x42, 0x82, 0x84, 'w', 'e', 'b', 'm'}) {
			return "video", mime, ".webm"
		}
	}
	return "", "", ""
}

func displayName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name))
	runes := []rune(name)
	if len(runes) > 120 {
		name = string(runes[:120])
	}
	if name == "" || name == "." {
		return "未命名背景"
	}
	return name
}

func (s *Service) Create(ctx context.Context, name string, input io.Reader) (model.SceneAsset, error) {
	var result model.SceneAsset
	header := make([]byte, 512)
	n, err := io.ReadFull(input, header)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return result, err
	}
	header = header[:n]
	kind, mime, extension := mediaType(header)
	if kind == "" {
		return result, ErrUnsupported
	}
	limit := ImageLimit
	if kind == "video" {
		limit = VideoLimit
	}
	file, err := os.CreateTemp(s.MediaDir, ".upload-*")
	if err != nil {
		return result, err
	}
	defer os.Remove(file.Name())
	size, copyErr := io.Copy(file, io.LimitReader(io.MultiReader(bytes.NewReader(header), input), limit+1))
	closeErr := file.Close()
	if size > limit {
		return result, ErrTooLarge
	}
	if copyErr != nil {
		return result, copyErr
	}
	if closeErr != nil {
		return result, closeErr
	}
	if err = ctx.Err(); err != nil {
		return result, err
	}
	id := uuid.NewString()
	filename := id + extension
	destination := filepath.Join(s.MediaDir, filename)
	if err = os.Rename(file.Name(), destination); err != nil {
		return result, err
	}
	result = model.SceneAsset{ID: id, Name: displayName(name), Kind: kind, MIMEType: mime, Size: size, Filename: filename, URL: mediaURL(filename)}
	if err = s.DB.WithContext(ctx).Create(&result).Error; err != nil {
		_ = os.Remove(destination)
	}
	return result, err
}

func validFilename(name string) bool {
	ext := filepath.Ext(name)
	switch ext {
	case ".png", ".jpg", ".webp", ".gif", ".mp4", ".webm":
	default:
		return false
	}
	id, err := uuid.Parse(strings.TrimSuffix(name, ext))
	return err == nil && name == id.String()+ext
}

func (s *Service) Open(ctx context.Context, filename string) (*os.File, model.SceneAsset, error) {
	var asset model.SceneAsset
	if !validFilename(filename) {
		return nil, asset, gorm.ErrRecordNotFound
	}
	if err := s.DB.WithContext(ctx).First(&asset, "filename = ?", filename).Error; err != nil {
		return nil, asset, err
	}
	full := filepath.Join(s.MediaDir, filename)
	info, err := os.Lstat(full)
	if err != nil || !info.Mode().IsRegular() {
		return nil, asset, gorm.ErrRecordNotFound
	}
	f, err := os.Open(full)
	return f, asset, err
}

func (s *Service) Delete(ctx context.Context, id string) error {
	if _, err := uuid.Parse(id); err != nil {
		return gorm.ErrRecordNotFound
	}
	return s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var asset model.SceneAsset
		if err := tx.First(&asset, "id = ?", id).Error; err != nil {
			return err
		}
		if !validFilename(asset.Filename) {
			return gorm.ErrRecordNotFound
		}
		if err := os.Remove(filepath.Join(s.MediaDir, asset.Filename)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return tx.Delete(&asset).Error
	})
}
