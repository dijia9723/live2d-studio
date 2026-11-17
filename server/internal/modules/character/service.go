// 本文件实现角色数据的持久化与 Cubism 模型压缩包的安全导入。

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

// Service 负责角色的增删改查与模型目录管理。
// ModelsDir 下每个角色使用独立的 UUID 目录，避免不同模型的文件互相覆盖。
type Service struct {
	DB        *gorm.DB
	ModelsDir string
}

// List 按创建时间升序返回全部角色。
func (s *Service) List() ([]model.Character, error) {
	v := []model.Character{}
	err := s.DB.Order("created_at asc").Find(&v).Error
	return v, err
}

// Get 按 ID 读取单个角色，不存在时返回 gorm.ErrRecordNotFound。
func (s *Service) Get(id string) (model.Character, error) {
	var v model.Character
	err := s.DB.First(&v, "id = ?", id).Error
	return v, err
}

// Update 只更新名称、描述与提示词，保留导入时生成的模型路径等字段。
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

// Import 解压导出的 Cubism 模型并创建角色记录。
// 安全约束：文件数量与解压总大小受限，拒绝绝对路径、路径穿越、盘符与符号链接，
// 忽略未知扩展名的文件，并要求压缩包内恰有一个 .model3.json。
// 导入失败时会删除整个目标目录，不留半成品；成功后校验模型引用未越界且资源确实存在。
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

// extract 写入单个文件，并用 LimitReader 加实际字节数比对，
// 防止压缩包声明的未压缩大小与实际内容不一致。
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

// validateReferences 解析 .model3.json 的 FileReferences，要求存在 Moc 引用，
// 并确认所有被引用资源都位于解压目录内且已成功落盘，防止模型在运行时读取目录外的文件。
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
