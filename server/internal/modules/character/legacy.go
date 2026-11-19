package character

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode"
)

const maxManifestBytes = 2 << 20

type manifestMotion struct {
	File    string   `json:"file"`
	Sound   string   `json:"sound,omitempty"`
	FadeIn  *float64 `json:"fade_in,omitempty"`
	FadeOut *float64 `json:"fade_out,omitempty"`
}

type manifestExpression struct {
	Name string `json:"name"`
	File string `json:"file"`
}

type manifestActions struct {
	Motions     map[string][]manifestMotion `json:"motions,omitempty"`
	Expressions []manifestExpression        `json:"expressions,omitempty"`
}

type legacyManifest struct {
	Model    string          `json:"model"`
	Name     string          `json:"name,omitempty"`
	Textures json.RawMessage `json:"textures"`
	Physics  string          `json:"physics,omitempty"`
	Pose     string          `json:"pose,omitempty"`
	manifestActions
}

func modelManifestKind(file string) int {
	name := strings.ToLower(path.Base(file))
	switch {
	case strings.HasSuffix(name, ".model3.json"):
		return 3
	case name == "model.json" || strings.HasSuffix(name, ".model.json"):
		return 2
	default:
		return 0
	}
}

func modelName(file string) string {
	name := path.Base(file)
	for _, suffix := range []string{".model3.json", ".model.json", ".json"} {
		if strings.HasSuffix(strings.ToLower(name), suffix) {
			return name[:len(name)-len(suffix)]
		}
	}
	return name
}

func modelResourceExtension(ext string) bool {
	switch ext {
	case ".json", ".moc3", ".moc", ".mtn", ".physics", ".pose", ".png", ".jpg", ".jpeg", ".wav", ".mp3", ".ogg", ".m4a", ".txt":
		return true
	default:
		return false
	}
}

func readModelManifest(root, file string) ([]byte, error) {
	manifest, err := os.OpenInRoot(root, filepath.FromSlash(file))
	if err != nil {
		return nil, err
	}
	defer manifest.Close()
	data, err := io.ReadAll(io.LimitReader(manifest, maxManifestBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxManifestBytes {
		return nil, fmt.Errorf("模型清单不得超过 2MB")
	}
	return repairJSONEscapes(data), nil
}

// repairJSONEscapes 修复游戏提取清单中常见的非法字符：
// 非法 UTF-8 字节、字符串内未转义的控制字符，以及 \ 后跟非转义字符。
func repairJSONEscapes(data []byte) []byte {
	data = bytes.ToValidUTF8(data, []byte("\uFFFD"))
	result := make([]byte, 0, len(data))
	quoted, escaped := false, false
	for index := 0; index < len(data); index++ {
		char := data[index]
		if !quoted {
			if char == '"' {
				quoted = true
			}
			result = append(result, char)
			continue
		}
		if escaped {
			escaped = false
			result = append(result, char)
			continue
		}
		if char < 0x20 {
			result = append(result, ' ')
			continue
		}
		if char != '\\' {
			if char == '"' {
				quoted = false
			}
			result = append(result, char)
			continue
		}
		if index+1 >= len(data) {
			result = append(result, '\\', '\\')
			continue
		}
		switch next := data[index+1]; {
		case next == '"' || next == '\\' || next == '/' || next == 'b' || next == 'f' || next == 'n' || next == 'r' || next == 't':
			result = append(result, char)
			escaped = true
		case next == 'u' && index+5 < len(data) && isHexQuad(data[index+2:index+6]):
			result = append(result, char)
			escaped = true
		default:
			result = append(result, '\\', '\\')
		}
	}
	return result
}

func isHexQuad(data []byte) bool {
	if len(data) < 4 {
		return false
	}
	for _, char := range data[:4] {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') && (char < 'A' || char > 'F') {
			return false
		}
	}
	return true
}

func stripLegacyTrailingCommas(data []byte) []byte {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	result := data[:0]
	quoted, escaped := false, false
	for index, char := range data {
		if quoted {
			switch {
			case escaped:
				escaped = false
			case char == '\\':
				escaped = true
			case char == '"':
				quoted = false
			}
		} else if char == '"' {
			quoted = true
		} else if char == ',' {
			next := bytes.TrimLeft(data[index+1:], " \t\r\n")
			if len(next) > 0 && (next[0] == ']' || next[0] == '}') {
				continue
			}
		}
		result = append(result, char)
	}
	return result
}

// sanitizeLegacyJSON 兼容从游戏中提取出的“准 JSON”清单：
// 去掉注释、补齐缺失的逗号，再移除多余的尾逗号。
func sanitizeLegacyJSON(data []byte) []byte {
	return stripLegacyTrailingCommas(insertMissingCommas(stripJSONComments(data)))
}

// stripJSONComments 删除字符串外的 // 行注释与 /* */ 块注释。
func stripJSONComments(data []byte) []byte {
	result := make([]byte, 0, len(data))
	quoted, escaped := false, false
	for index := 0; index < len(data); index++ {
		char := data[index]
		if quoted {
			result = append(result, char)
			switch {
			case escaped:
				escaped = false
			case char == '\\':
				escaped = true
			case char == '"':
				quoted = false
			}
			continue
		}
		if char == '"' {
			quoted = true
			result = append(result, char)
			continue
		}
		if char == '/' && index+1 < len(data) {
			if data[index+1] == '/' {
				for index < len(data) && data[index] != '\n' {
					index++
				}
				result = append(result, '\n')
				continue
			}
			if data[index+1] == '*' {
				index += 2
				for index+1 < len(data) && !(data[index] == '*' && data[index+1] == '/') {
					index++
				}
				index++
				result = append(result, ' ')
				continue
			}
		}
		result = append(result, char)
	}
	return result
}

// insertMissingCommas 在合法的值之间补上缺失的逗号。
// 仅在字符串外、且上一个记号已经构成完整值时触发，因此不会改动合法 JSON。
func insertMissingCommas(data []byte) []byte {
	result := make([]byte, 0, len(data)+16)
	quoted, escaped := false, false
	inNumber, inWord, valueEnd := false, false, false
	for _, char := range data {
		if quoted {
			result = append(result, char)
			switch {
			case escaped:
				escaped = false
			case char == '\\':
				escaped = true
			case char == '"':
				quoted = false
				valueEnd = true
			}
			continue
		}
		switch {
		case char == '"':
			if valueEnd {
				result = append(result, ',')
			}
			result = append(result, char)
			quoted, inNumber, inWord, valueEnd = true, false, false, false
		case char == '{' || char == '[':
			if valueEnd {
				result = append(result, ',')
			}
			result = append(result, char)
			inNumber, inWord, valueEnd = false, false, false
		case char == '}' || char == ']':
			result = append(result, char)
			inNumber, inWord, valueEnd = false, false, true
		case char == ',' || char == ':':
			result = append(result, char)
			inNumber, inWord, valueEnd = false, false, false
		case char == ' ' || char == '\t' || char == '\r' || char == '\n':
			result = append(result, char)
			inNumber, inWord = false, false
		case char == '-' || (char >= '0' && char <= '9') || (inNumber && strings.ContainsRune(".eE+", rune(char))):
			if !inNumber {
				if valueEnd {
					result = append(result, ',')
				}
				inNumber, inWord, valueEnd = true, false, false
			}
			result = append(result, char)
			valueEnd = true
		case (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z'):
			if !inWord {
				if valueEnd {
					result = append(result, ',')
				}
				inWord, inNumber, valueEnd = true, false, false
			}
			result = append(result, char)
			valueEnd = true
		default:
			result = append(result, char)
			inNumber, inWord = false, false
		}
	}
	return result
}

// cleanReference 去除资源引用两端的空白与误带的引号，保留文件名中的空格。
func cleanReference(ref string) string {
	return strings.Trim(strings.TrimSpace(ref), "'\"")
}

func normalizeLegacyManifest(root, file string) (legacyManifest, error) {
	var legacy legacyManifest
	data, err := readModelManifest(root, file)
	if err != nil {
		return legacy, err
	}
	var document map[string]json.RawMessage
	data = sanitizeLegacyJSON(data)
	if json.Unmarshal(data, &legacy) != nil || json.Unmarshal(data, &document) != nil || !strings.EqualFold(path.Ext(cleanReference(legacy.Model)), ".moc") {
		return legacy, fmt.Errorf("旧版模型清单无效或缺少 .moc 引用")
	}
	legacy.Model = cleanReference(legacy.Model)
	legacy.Physics = cleanReference(legacy.Physics)
	legacy.Pose = cleanReference(legacy.Pose)
	var textures []string
	if json.Unmarshal(legacy.Textures, &textures) != nil {
		// 部分游戏把贴图按分辨率分组，取其中第一组编号贴图。
		var grouped map[string][]string
		if json.Unmarshal(legacy.Textures, &grouped) == nil {
			keys := make([]string, 0, len(grouped))
			for key := range grouped {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for _, key := range keys {
				if textures = grouped[key]; len(textures) > 0 {
					break
				}
			}
		}
	}
	if len(textures) == 0 {
		return legacy, fmt.Errorf("旧版模型清单缺少贴图")
	}
	for index := range textures {
		textures[index] = cleanReference(textures[index])
	}
	// 游戏提取出的清单常带空动作或空表情项，它们不是可加载资源，直接丢弃。
	for group, motions := range legacy.Motions {
		kept := motions[:0]
		for _, motion := range motions {
			motion.File = cleanReference(motion.File)
			motion.Sound = cleanReference(motion.Sound)
			if motion.File == "" {
				continue
			}
			kept = append(kept, motion)
		}
		if len(kept) == 0 {
			delete(legacy.Motions, group)
			continue
		}
		legacy.Motions[group] = kept
	}
	expressions := legacy.Expressions[:0]
	for _, expression := range legacy.Expressions {
		expression.File = cleanReference(expression.File)
		if expression.File != "" {
			expressions = append(expressions, expression)
		}
	}
	legacy.Expressions = expressions
	check := func(ref *string) error {
		*ref = strings.ReplaceAll(*ref, "\\", "/")
		clean := path.Join(path.Dir(file), *ref)
		if *ref == "" || path.IsAbs(*ref) || strings.ContainsAny(*ref, ":%?#") || strings.ContainsFunc(*ref, unicode.IsControl) || clean == ".." || strings.HasPrefix(clean, "../") {
			return fmt.Errorf("旧版模型包含不安全的资源引用")
		}
		resource, err := os.OpenInRoot(root, filepath.FromSlash(clean))
		if err != nil {
			return fmt.Errorf("缺少模型资源: %s", *ref)
		}
		defer resource.Close()
		info, err := resource.Stat()
		if err != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("缺少模型资源: %s", *ref)
		}
		return nil
	}
	refs := []*string{&legacy.Model}
	for index := range textures {
		refs = append(refs, &textures[index])
	}
	for _, optional := range []*string{&legacy.Physics, &legacy.Pose} {
		if *optional != "" {
			refs = append(refs, optional)
		}
	}
	for _, motions := range legacy.Motions {
		for index := range motions {
			refs = append(refs, &motions[index].File)
			if motions[index].Sound != "" {
				refs = append(refs, &motions[index].Sound)
			}
		}
	}
	for index := range legacy.Expressions {
		refs = append(refs, &legacy.Expressions[index].File)
	}
	for _, ref := range refs {
		if err := check(ref); err != nil {
			return legacy, err
		}
	}
	for key, value := range map[string]any{
		"model": legacy.Model, "textures": textures, "physics": legacy.Physics, "pose": legacy.Pose,
		"motions": legacy.Motions, "expressions": legacy.Expressions,
	} {
		for field := range document {
			if strings.EqualFold(key, field) {
				delete(document, field)
			}
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			return legacy, err
		}
		if string(encoded) != `""` && string(encoded) != "null" {
			document[key] = encoded
		}
	}
	return legacy, writeLegacyManifest(root, file, document)
}

var numberedTexture = regexp.MustCompile(`(?i)^texture_([0-9]+)\.png$`)
var textureResolution = regexp.MustCompile(`^\.[0-9]+$`)

func generateLegacyManifest(root, moc string) (string, error) {
	dir := path.Dir(moc)
	stem := strings.TrimSuffix(path.Base(moc), path.Ext(moc))
	diskDir := filepath.Join(root, filepath.FromSlash(dir))
	entries, err := os.ReadDir(diskDir)
	if err != nil {
		return "", err
	}
	var sets [][]string
	for _, entry := range entries {
		if suffix, found := strings.CutPrefix(entry.Name(), stem); entry.IsDir() && found && textureResolution.MatchString(suffix) {
			entries, err := os.ReadDir(filepath.Join(diskDir, entry.Name()))
			if err != nil {
				return "", err
			}
			textures, err := numberedTextures(entries, entry.Name())
			if err != nil {
				return "", err
			}
			if len(textures) > 0 {
				sets = append(sets, textures)
			}
		}
	}
	textures, err := numberedTextures(entries, "")
	if err != nil {
		return "", err
	}
	if len(textures) > 0 {
		sets = append(sets, textures)
	}
	if len(sets) != 1 {
		return "", fmt.Errorf("只有 .moc 时需提供一套从 texture_00.png 开始编号的贴图；多套贴图请提供 .model.json")
	}
	manifest := map[string]any{"model": path.Base(moc), "textures": sets[0]}
	for _, name := range []string{stem + ".physics.json", stem + ".physics"} {
		if info, err := os.Stat(filepath.Join(diskDir, name)); err == nil && info.Mode().IsRegular() {
			manifest["physics"] = name
			break
		}
	}
	file := path.Join(dir, stem+".model.json")
	return file, writeLegacyManifest(root, file, manifest)
}

func numberedTextures(entries []os.DirEntry, prefix string) ([]string, error) {
	indexed := make(map[int]string)
	for _, entry := range entries {
		if entry.IsDir() || !numberedTexture.MatchString(entry.Name()) {
			continue
		}
		var index int
		if _, err := fmt.Sscanf(numberedTexture.FindStringSubmatch(entry.Name())[1], "%d", &index); err != nil || indexed[index] != "" {
			return nil, fmt.Errorf("旧版模型贴图编号无效，请提供 .model.json")
		}
		indexed[index] = path.Join(prefix, entry.Name())
	}
	textures := make([]string, len(indexed))
	for index := range textures {
		if textures[index] = indexed[index]; textures[index] == "" {
			return nil, fmt.Errorf("旧版模型贴图编号不连续，请提供 .model.json")
		}
	}
	return textures, nil
}

func writeLegacyManifest(root, file string, manifest any) error {
	data, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	if len(data) > maxManifestBytes {
		return fmt.Errorf("模型清单不得超过 2MB")
	}
	return os.WriteFile(filepath.Join(root, filepath.FromSlash(file)), data, 0600)
}
