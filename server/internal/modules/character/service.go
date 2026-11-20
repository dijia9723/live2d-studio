// 本文件实现角色数据的持久化与 Cubism 模型压缩包的安全导入。

package character

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"server/internal/model"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// Service 负责角色的增删改查与模型目录管理。
// ModelsDir 下每个角色使用独立的 UUID 目录，避免不同模型的文件互相覆盖；
// AssetsDir 存放随数据目录分发的初始模型，不打包进二进制。
type Service struct {
	DB        *gorm.DB
	ModelsDir string
	AssetsDir string
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

// Update 更新基本资料和请求中指定的朗读配置。
func (s *Service) Update(id string, v model.Character) (model.Character, error) {
	fields := []string{"name", "description", "system_prompt"}
	if v.Speech != nil {
		fields = append(fields, "speech")
		if v.Speech.Mode == "inherit" {
			v.Speech = nil
		}
	}
	if err := s.DB.Model(&model.Character{}).Where("id = ?", id).Select(fields).Updates(v).Error; err != nil {
		return model.Character{}, err
	}
	return s.Get(id)
}

// Delete 删除角色及其会话、消息、记忆与导入生成的模型目录。
// 模型目录只清理 /models/<单级目录>/... 形式的本地上传副本，其他来源路径不受影响。
func (s *Service) Delete(id string) error {
	ch, err := s.Get(id)
	if err != nil {
		return err
	}
	err = s.DB.Transaction(func(tx *gorm.DB) error {
		var conversations []string
		if err := tx.Model(&model.Conversation{}).Where("character_id = ?", id).Pluck("id", &conversations).Error; err != nil {
			return err
		}
		if len(conversations) > 0 {
			if err := tx.Where("conversation_id IN ?", conversations).Delete(&model.Message{}).Error; err != nil {
				return err
			}
		}
		if err := tx.Where("character_id = ?", id).Delete(&model.Conversation{}).Error; err != nil {
			return err
		}
		if err := tx.Where("character_id = ?", id).Delete(&model.CharacterMemory{}).Error; err != nil {
			return err
		}
		return tx.Delete(&model.Character{}, "id = ?", id).Error
	})
	if err != nil {
		return err
	}
	s.removeModelDir(ch.ModelPath)
	return nil
}

// removeModelDir 删除导入时生成的模型副本；路径必须落在 /models/<目录>/ 内。
func (s *Service) removeModelDir(modelPath string) {
	u, err := url.Parse(modelPath)
	if err != nil || u.Host != "" || u.Scheme != "" {
		return
	}
	rest, ok := strings.CutPrefix(u.Path, "/models/")
	if !ok {
		return
	}
	dir, _, ok := strings.Cut(rest, "/")
	if !ok || dir == "" || dir == "." || dir == ".." || strings.ContainsAny(dir, "\\:") {
		return
	}
	_ = os.RemoveAll(filepath.Join(s.ModelsDir, dir))
}

// Import 解压导出的 Cubism 模型并创建角色记录。
// 安全约束：文件数量与解压总大小受限，拒绝绝对路径、路径穿越、盘符与符号链接，
// 忽略未知扩展名的文件，并要求压缩包内恰有一个模型。
// 导入失败时会删除整个目标目录，不留半成品；成功后校验模型引用未越界且资源确实存在。
func (s *Service) Import(file string) (model.Character, error) {
	z, err := zip.OpenReader(file)
	if err != nil {
		return model.Character{}, fmt.Errorf("无法读取 ZIP 文件")
	}
	defer z.Close()
	return s.importArchive(&z.Reader, "")
}

// importArchive 是上传导入与初始模型导入共用的资源校验、解压及落库流程。
// existingID 非空时只更新已有角色的模型路径，保留人设、命名、会话与记忆。
func (s *Service) importArchive(z *zip.Reader, existingID string) (model.Character, error) {
	var result model.Character
	if len(z.File) > 4000 {
		return result, fmt.Errorf("模型文件数量过多")
	}
	id := uuid.NewString()
	dest := filepath.Join(s.ModelsDir, id)
	if err := os.MkdirAll(dest, 0700); err != nil {
		return result, err
	}
	success := false
	defer func() {
		if !success {
			_ = os.RemoveAll(dest)
		}
	}()
	var total uint64
	var err error
	var manifests []string
	var legacyMocs []string
	for _, f := range z.File {
		name := strings.ReplaceAll(f.Name, "\\", "/")
		clean := path.Clean(name)
		if path.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") || strings.Contains(clean, ":") || f.Mode()&os.ModeSymlink != 0 {
			return result, fmt.Errorf("压缩包包含不安全路径")
		}
		ext := strings.ToLower(path.Ext(clean))
		if !f.FileInfo().IsDir() && !modelResourceExtension(ext) {
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
		if modelManifestKind(clean) != 0 {
			manifests = append(manifests, clean)
		}
		if ext == ".moc" {
			legacyMocs = append(legacyMocs, clean)
		}
	}
	// 选中父目录或包含 normal/destroy 等变体时会有多个模型，按“最佳模型”排序后逐个尝试，
	// 第一个通过校验的即被导入；只有全部失败才返回首个错误。
	candidates := make([]importCandidate, 0, len(manifests)+len(legacyMocs))
	for _, file := range manifests {
		candidates = append(candidates, importCandidate{file: file})
	}
	if len(manifests) == 0 {
		for _, moc := range legacyMocs {
			candidates = append(candidates, importCandidate{file: moc, generate: true})
		}
	}
	if len(candidates) == 0 {
		return result, fmt.Errorf("未找到可导入的模型，请选择包含 .model3.json、.model.json 或 .moc 的包")
	}
	rankImportCandidates(dest, candidates)
	var modelFile, name string
	var firstErr error
	for _, candidate := range candidates {
		file := candidate.file
		if candidate.generate {
			generated, err := generateLegacyManifest(dest, candidate.file)
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				continue
			}
			file = generated
		}
		prepared, err := prepareModel(dest, file)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		modelFile, name = file, prepared
		break
	}
	if modelFile == "" {
		if firstErr == nil {
			firstErr = fmt.Errorf("模型导入失败，请检查清单与资源是否完整")
		}
		return result, firstErr
	}
	modelURL := (&url.URL{Path: "/models/" + id + "/" + modelFile}).EscapedPath()
	result = model.Character{ID: id, Name: name, Description: "导入的 Live2D 角色", ModelPath: modelURL, Color: "#a78bfa", SystemPrompt: "你是" + name + "，一位友好温暖的虚拟伙伴。用自然、简短的中文与用户交流。"}
	if existingID == "" {
		if err = s.DB.Create(&result).Error; err != nil {
			return result, err
		}
	} else {
		modelPath := result.ModelPath
		result = model.Character{}
		err = s.DB.Transaction(func(tx *gorm.DB) error {
			if err := tx.Model(&model.Character{}).Where("id = ?", existingID).Update("model_path", modelPath).Error; err != nil {
				return err
			}
			return tx.First(&result, "id = ?", existingID).Error
		})
		if err != nil {
			return result, err
		}
	}
	success = true
	return result, nil
}

// importCandidate 是一个待尝试的模型入口：清单文件，或只有 .moc 时需要补生成清单。
type importCandidate struct {
	file     string
	generate bool
}

// prepareModel 校验单个候选模型并返回角色名称；旧版清单会在此规范化。
func prepareModel(root, file string) (string, error) {
	name := modelName(file)
	if modelManifestKind(file) == 2 {
		legacy, err := normalizeLegacyManifest(root, file)
		if err != nil {
			return "", err
		}
		if name == "" || strings.EqualFold(name, "model") {
			name = strings.TrimSpace(legacy.Name)
			if name == "" || strings.EqualFold(name, "model") {
				name = strings.TrimSuffix(path.Base(legacy.Model), path.Ext(legacy.Model))
			}
		}
		return name, nil
	}
	return name, validateReferences(root, file)
}

// rankImportCandidates 按“最可能是主角色的模型”排序：
// normal/普通形态优先，destroy 等破坏形态靠后，规范命名的清单与更完整的清单优先。
func rankImportCandidates(root string, candidates []importCandidate) {
	sort.SliceStable(candidates, func(i, j int) bool {
		left, right := modelCandidateScore(candidates[i].file), modelCandidateScore(candidates[j].file)
		if left != right {
			return left > right
		}
		leftSize, rightSize := candidateSize(root, candidates[i].file), candidateSize(root, candidates[j].file)
		if leftSize != rightSize {
			return leftSize > rightSize
		}
		return candidates[i].file < candidates[j].file
	})
}

func candidateSize(root, file string) int64 {
	info, err := os.Stat(filepath.Join(root, filepath.FromSlash(file)))
	if err != nil {
		return 0
	}
	return info.Size()
}

func modelCandidateScore(file string) int {
	lower := strings.ToLower(filepath.ToSlash(file))
	score := 0
	if strings.Contains(lower, "normal") {
		score += 60
	}
	if strings.Contains(lower, "destroy") {
		score -= 60
	}
	base := path.Base(lower)
	if strings.HasPrefix(base, ".") {
		score -= 20
	}
	var stem string
	switch {
	case base == "model.json":
		stem = "model"
	case strings.HasSuffix(base, ".model.json"):
		stem = strings.TrimSuffix(base, ".model.json")
	case strings.HasSuffix(base, ".model3.json"):
		stem = strings.TrimSuffix(base, ".model3.json")
	default:
		stem = strings.TrimSuffix(base, path.Ext(base))
	}
	if stem == "model" {
		score += 5
	}
	if stem != "" && stem == path.Base(path.Dir(lower)) {
		score += 30
	}
	return score
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
	data, err := readModelManifest(root, file)
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
