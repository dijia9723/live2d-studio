// 初始模型放在数据目录的 assets/ 下随文件分发，不再打包进二进制。
package character

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"server/internal/model"

	"gorm.io/gorm"
)

// EnsureInitialModels 幂等导入初始模型；模型目录缺失或角色已被删除时跳过。
func (s *Service) EnsureInitialModels() error {
	for _, initial := range []struct{ ID, Folder, LegacyPath string }{
		{"mao", "mao_pro", "/live2d-models/mao_pro/runtime/mao_pro.model3.json"},
		{"shizuku", "shizuku", "/live2d-models/shizuku/runtime/shizuku.model3.json"},
	} {
		var ch model.Character
		if err := s.DB.First(&ch, "id = ?", initial.ID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				continue
			}
			return err
		}
		if ch.ModelPath != initial.LegacyPath {
			continue
		}
		root := filepath.Join(s.AssetsDir, initial.Folder)
		if info, err := os.Stat(root); err != nil || !info.IsDir() {
			continue
		}
		if err := s.importDirectory(root, ch.ID); err != nil {
			return fmt.Errorf("导入初始模型 %s: %w", ch.Name, err)
		}
	}
	return nil
}

// importDirectory 把磁盘上的模型目录打包为 ZIP 后复用统一的导入校验流程。
func (s *Service) importDirectory(root, existingID string) error {
	source := os.DirFS(root)
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	err := fs.WalkDir(source, ".", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		data, err := fs.ReadFile(source, name)
		if err != nil {
			return err
		}
		file, err := writer.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store})
		if err != nil {
			return err
		}
		_, err = file.Write(data)
		return err
	})
	if err != nil {
		_ = writer.Close()
		return err
	}
	if err = writer.Close(); err != nil {
		return err
	}
	archive, err := zip.NewReader(bytes.NewReader(buffer.Bytes()), int64(buffer.Len()))
	if err != nil {
		return err
	}
	_, err = s.importArchive(archive, existingID)
	return err
}
