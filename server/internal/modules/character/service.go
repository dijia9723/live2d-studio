package character

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	"server/internal/model"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type Service struct {
	DB        *gorm.DB
	ModelsDir string
}

func (s *Service) List() ([]model.Character, error) {
	v := []model.Character{}
	err := s.DB.Order("created_at asc").Find(&v).Error
	return v, err
}
func (s *Service) Get(id string) (model.Character, error) {
	var v model.Character
	err := s.DB.First(&v, "id = ?", id).Error
	return v, err
}
func (s *Service) Update(id string, v model.Character) (model.Character, error) {
	old, err := s.Get(id)
	if err != nil {
		return old, err
	}
	old.Name = v.Name
	old.Description = v.Description
	old.SystemPrompt = v.SystemPrompt
	err = s.DB.Save(&old).Error
	return old, err
}

// Import extracts an exported Cubism model. Archives are bounded and may not
// escape their destination, contain symlinks, or refer to remote resources.
func (s *Service) Import(file string) (model.Character, error) {
	var result model.Character
	z, err := zip.OpenReader(file)
	if err != nil {
		return result, fmt.Errorf("无法读取 ZIP 文件")
	}
	defer z.Close()
	if len(z.File) > 4000 {
		return result, fmt.Errorf("模型文件数量过多")
	}
	id := uuid.NewString()
	dest := filepath.Join(s.ModelsDir, id)
	if err = os.MkdirAll(dest, 0700); err != nil {
		return result, err
	}
	success := false
	defer func() {
		if !success {
			_ = os.RemoveAll(dest)
		}
	}()
	var total uint64
	var models []string
	for _, f := range z.File {
		name := strings.ReplaceAll(f.Name, "\\", "/")
		clean := path.Clean(name)
		if path.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") || strings.Contains(clean, ":") || f.Mode()&os.ModeSymlink != 0 {
			return result, fmt.Errorf("压缩包包含不安全路径")
		}
		ext := strings.ToLower(path.Ext(clean))
		if !f.FileInfo().IsDir() && ext != ".json" && ext != ".moc3" && ext != ".png" && ext != ".jpg" && ext != ".jpeg" && ext != ".wav" && ext != ".mp3" && ext != ".txt" {
			continue
		}
		if f.UncompressedSize64 > 200<<20 || total > 200<<20-f.UncompressedSize64 {
			return result, fmt.Errorf("解压后的模型不得超过 200MB")
		}
		total += f.UncompressedSize64
		target := filepath.Join(dest, filepath.FromSlash(clean))
		if f.FileInfo().IsDir() {
			if err = os.MkdirAll(target, 0700); err != nil {
				return result, err
			}
			continue
		}
		if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return result, err
		}
		err = extract(f, target)
		if err != nil {
			return result, err
		}
		if strings.HasSuffix(clean, ".model3.json") {
			models = append(models, clean)
		}
	}
	if len(models) != 1 {
		return result, fmt.Errorf("ZIP 中应包含且仅包含一个 .model3.json 文件")
	}
	modelFile := models[0]
	if err = validateReferences(dest, modelFile); err != nil {
		return result, err
	}
	name := strings.TrimSuffix(path.Base(modelFile), ".model3.json")
	result = model.Character{ID: id, Name: name, Description: "导入的 Live2D 角色", ModelPath: "/models/" + id + "/" + modelFile, Color: "#a78bfa", SystemPrompt: "你是" + name + "，一位友好温暖的虚拟伙伴。用自然、简短的中文与用户交流。"}
	if err = s.DB.Create(&result).Error; err != nil {
		return result, err
	}
	success = true
	return result, nil
}
func extract(f *zip.File, target string) error {
	in, err := f.Open()
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	n, copyErr := io.Copy(out, io.LimitReader(in, int64(f.UncompressedSize64)+1))
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if uint64(n) != f.UncompressedSize64 {
		return fmt.Errorf("文件大小不一致")
	}
	return nil
}
func validateReferences(root, file string) error {
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(file)))
	if err != nil {
		return err
	}
	var manifest struct {
		FileReferences map[string]json.RawMessage `json:"FileReferences"`
	}
	if json.Unmarshal(data, &manifest) != nil || len(manifest.FileReferences) == 0 {
		return fmt.Errorf("模型描述文件无效")
	}
	var refs []string
	var walk func(any)
	walk = func(v any) {
		switch x := v.(type) {
		case string:
			refs = append(refs, x)
		case []any:
			for _, i := range x {
				walk(i)
			}
		case map[string]any:
			for k, i := range x {
				if k == "File" {
					walk(i)
				}
			}
		}
	}
	for key, raw := range manifest.FileReferences {
		if key == "Moc" || key == "Textures" || key == "Physics" || key == "Pose" || key == "DisplayInfo" || key == "Motions" || key == "Expressions" {
			var v any
			if json.Unmarshal(raw, &v) != nil {
				return fmt.Errorf("模型引用无效")
			}
			if key == "Motions" {
				if groups, ok := v.(map[string]any); ok {
					for _, group := range groups {
						walk(group)
					}
				}
			} else {
				walk(v)
			}
		}
	}
	var moc string
	_ = json.Unmarshal(manifest.FileReferences["Moc"], &moc)
	if moc == "" {
		return fmt.Errorf("模型缺少 Moc 引用")
	}
	for _, ref := range refs {
		clean := path.Clean(path.Join(path.Dir(file), strings.ReplaceAll(ref, "\\", "/")))
		if strings.Contains(ref, ":") || strings.HasPrefix(ref, "/") || clean == ".." || strings.HasPrefix(clean, "../") {
			return fmt.Errorf("模型引用越界")
		}
		info, e := os.Stat(filepath.Join(root, filepath.FromSlash(clean)))
		if e != nil || info.IsDir() {
			return fmt.Errorf("缺少模型资源: %s", ref)
		}
	}
	return nil
}
