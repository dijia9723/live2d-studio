// 本文件实现素材的类型嗅探、流式落盘、文件名校验与记录维护。

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

// ImageLimit 是单张图片允许的最大字节数。
// VideoLimit 是单个视频允许的最大字节数。
const (
	ImageLimit int64 = 15 << 20
	VideoLimit int64 = 150 << 20
	HTMLLimit  int64 = 5 << 20
)

var (
	// ErrUnsupported 表示文件头不属于允许的图片或视频类型。
	ErrUnsupported = errors.New("请选择 PNG、JPEG、WebP、GIF 图片，MP4、WebM 视频或 HTML 文件")
	// ErrTooLarge 表示文件超过了对应类型的大小上限。
	ErrTooLarge = errors.New("图片最大 15MB，视频最大 150MB，HTML 最大 5MB")
)

// Service 负责素材落盘、类型校验与数据库记录维护，MediaDir 中只存放随机 UUID 文件名。
type Service struct {
	DB       *gorm.DB
	MediaDir string
}

// List 按创建时间倒序返回全部素材，并补全访问 URL。
func (s *Service) List(ctx context.Context) ([]model.SceneAsset, error) {
	result := []model.SceneAsset{}
	err := s.DB.WithContext(ctx).Order("created_at desc, rowid desc").Find(&result).Error
	for i := range result {
		result[i].URL = mediaURL(result[i].Filename)
	}
	return result, err
}

func mediaURL(name string) string { return "/scene-media/" + name }

// mediaType 依据文件头嗅探真实类型，返回类别、MIME 与规范化扩展名，不信任客户端文件名后缀。
// WebM 与 Matroska 共用 EBML 魔数，因此额外要求 DocType 元素，
// 避免把浏览器无法播放的普通 MKV 当作视频接受。
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
		// EBML 魔数同样被 Matroska 使用，需再确认 WebM 的 DocType 元素，
		// 以免任意 MKV 被当作可播放视频接受。
		if bytes.Contains(header, []byte{0x42, 0x82, 0x84, 'w', 'e', 'b', 'm'}) {
			return "video", mime, ".webm"
		}
	}
	return "", "", ""
}

// displayName 从上传文件名提取展示名：去掉路径与控制字符并限制为 120 个字符，
// 为空或仅为 "." 时使用默认名称。该名称只用于展示，不参与磁盘路径拼接。
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

// Create 先读取文件头判断类型，再流式写入临时文件并把大小限制在对应上限内，
// 随后原子重命名为 UUID 文件名并写入数据库；数据库失败时删除已落盘的文件。
func (s *Service) Create(ctx context.Context, name string, input io.Reader) (model.SceneAsset, error) {
	var result model.SceneAsset
	header := make([]byte, 512)
	n, err := io.ReadFull(input, header)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return result, err
	}
	header = header[:n]
	kind, mime, extension := mediaType(header)
	limit := ImageLimit
	switch strings.ToLower(filepath.Ext(name)) {
	case ".html", ".htm":
		markup := bytes.TrimSpace(bytes.TrimPrefix(header, []byte("\xef\xbb\xbf")))
		contentType := http.DetectContentType(markup)
		if !bytes.HasPrefix(markup, []byte("<")) || (contentType != "text/html; charset=utf-8" && contentType != "text/plain; charset=utf-8") {
			return result, ErrUnsupported
		}
		kind, mime, extension = "html", "text/html; charset=utf-8", ".html"
		limit = HTMLLimit
	}
	if kind == "" {
		return result, ErrUnsupported
	}
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

// validFilename 只接受“UUID + 允许的扩展名”的形式，杜绝路径穿越与任意文件读取。
func validFilename(name string) bool {
	ext := filepath.Ext(name)
	switch ext {
	case ".png", ".jpg", ".webp", ".gif", ".mp4", ".webm", ".html":
	default:
		return false
	}
	id, err := uuid.Parse(strings.TrimSuffix(name, ext))
	return err == nil && name == id.String()+ext
}

// Open 校验文件名与数据库记录后打开素材文件，并用 Lstat 拒绝符号链接与非普通文件。
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

// Delete 在事务内先删磁盘文件再删数据库记录；文件已不存在时仍继续清理记录，
// 避免留下无法删除的条目。
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
