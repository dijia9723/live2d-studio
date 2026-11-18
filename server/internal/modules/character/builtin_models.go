// 初始模型归后端管理，首次启动或升级旧数据时走统一导入流程。
package character

import (
	"archive/zip"
	"bytes"
	"embed"
	"fmt"
	"io/fs"

	"server/internal/model"
)

//go:embed all:assets
var initialModels embed.FS

// EnsureInitialModels 幂等导入初始模型；只迁移仍引用旧前端资源的角色。
func (s *Service) EnsureInitialModels() error {
	for _, initial := range []struct{ ID, Folder, LegacyPath string }{
		{"mao", "mao_pro", "/live2d-models/mao_pro/runtime/mao_pro.model3.json"},
		{"shizuku", "shizuku", "/live2d-models/shizuku/runtime/shizuku.model3.json"},
	} {
		var ch model.Character
		if err := s.DB.First(&ch, "id = ?", initial.ID).Error; err != nil {
			return err
		}
		if ch.ModelPath != initial.LegacyPath {
			continue
		}
		root, err := fs.Sub(initialModels, "assets/"+initial.Folder)
		if err != nil {
			return err
		}
		var buffer bytes.Buffer
		writer := zip.NewWriter(&buffer)
		err = fs.WalkDir(root, ".", func(name string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				return nil
			}
			data, err := fs.ReadFile(root, name)
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
		closeErr := writer.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		archive, err := zip.NewReader(bytes.NewReader(buffer.Bytes()), int64(buffer.Len()))
		if err != nil {
			return err
		}
		if _, err = s.importArchive(archive, ch.ID); err != nil {
			return fmt.Errorf("导入初始模型 %s: %w", ch.Name, err)
		}
	}
	return nil
}
