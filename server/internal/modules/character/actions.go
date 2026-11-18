// 本文件从当前角色的真实 model3.json 和资源文件读取动作、原生表情。
package character

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path"
	"sort"
	"strings"

	"server/internal/model"
)

// ErrActions 表示模型清单或模型文件不可读取，区别于合法的空动作列表。
var ErrActions = errors.New("当前模型的动作资源暂时无法读取，请检查模型文件是否完整。")

type Motion struct {
	ID           string `json:"id"`
	Group        string `json:"group"`
	Index        int    `json:"index"`
	Label        string `json:"label"`
	DefaultLabel string `json:"default_label"`
}

type NativeExpression struct {
	ID           string `json:"id"`
	Label        string `json:"label"`
	DefaultLabel string `json:"default_label"`
}

type Actions struct {
	CharacterID            string             `json:"character_id"`
	ModelPath              string             `json:"model_path"`
	Motions                []Motion           `json:"motions"`
	Expressions            []NativeExpression `json:"expressions"`
	Moods                  []NativeExpression `json:"moods"`
	ActionNames            model.ActionNames  `json:"action_names"`
	UnavailableMotions     int                `json:"unavailable_motions"`
	UnavailableExpressions int                `json:"unavailable_expressions"`
}

// Actions 绑定数据库中的角色模型；不接受模型传入的任意 URL 或文件路径。
func (s *Service) Actions(ctx context.Context, characterID string) (Actions, error) {
	var ch model.Character
	if err := s.DB.WithContext(ctx).First(&ch, "id = ?", characterID).Error; err != nil {
		return Actions{}, err
	}
	result := Actions{CharacterID: ch.ID, ModelPath: ch.ModelPath, Motions: []Motion{}, Expressions: []NativeExpression{}, ActionNames: ch.ActionNames}
	for _, preset := range []NativeExpression{{ID: "neutral", DefaultLabel: "自然"}, {ID: "happy", DefaultLabel: "开心"}, {ID: "sad", DefaultLabel: "难过"}, {ID: "surprised", DefaultLabel: "惊讶"}} {
		preset.Label = displayName(ch.ActionNames.Moods, preset.ID, preset.DefaultLabel)
		result.Moods = append(result.Moods, preset)
	}
	u, err := url.Parse(ch.ModelPath)
	if err != nil || u.Host != "" || u.Scheme != "" || u.RawQuery != "" || u.Fragment != "" {
		return result, ErrActions
	}
	var open func(string) (fs.File, error)
	var relative string
	switch {
	case strings.HasPrefix(u.Path, "/models/"):
		relative = strings.TrimPrefix(u.Path, "/models/")
		open = func(name string) (fs.File, error) { return os.OpenInRoot(s.ModelsDir, name) }
	default:
		return result, ErrActions
	}
	if !fs.ValidPath(relative) || strings.Contains(relative, "\\") || !strings.HasSuffix(relative, ".model3.json") {
		return result, ErrActions
	}
	f, err := open(relative)
	if err != nil {
		return result, ErrActions
	}
	defer f.Close()
	const maxManifestBytes = 2 << 20
	data, err := io.ReadAll(io.LimitReader(f, maxManifestBytes+1))
	if err != nil || len(data) > maxManifestBytes {
		return result, ErrActions
	}
	var manifest struct {
		FileReferences *struct {
			Motions     map[string][]struct{ File string } `json:"Motions"`
			Expressions []struct{ Name, File string }      `json:"Expressions"`
		} `json:"FileReferences"`
	}
	if json.Unmarshal(data, &manifest) != nil || manifest.FileReferences == nil {
		return result, ErrActions
	}
	// 引用可以包含 ../（如 runtime/../motions），但不能越出该角色模型目录。
	modelRoot := strings.SplitN(relative, "/", 2)[0] + "/"
	exists := func(reference string) bool {
		reference = strings.ReplaceAll(reference, "\\", "/")
		if reference == "" || path.IsAbs(reference) {
			return false
		}
		name := path.Join(path.Dir(relative), reference)
		if !fs.ValidPath(name) || !strings.HasPrefix(name, modelRoot) {
			return false
		}
		resource, openErr := open(name)
		if openErr != nil {
			return false
		}
		defer resource.Close()
		info, statErr := resource.Stat()
		return statErr == nil && info.Mode().IsRegular()
	}
	groups := make([]string, 0, len(manifest.FileReferences.Motions))
	for group := range manifest.FileReferences.Motions {
		groups = append(groups, group)
	}
	sort.Strings(groups)
	for _, group := range groups {
		for index, item := range manifest.FileReferences.Motions[group] {
			if err := ctx.Err(); err != nil {
				return result, err
			}
			if !exists(item.File) {
				result.UnavailableMotions++
				continue
			}
			id, _ := json.Marshal([]any{group, index})
			label := group
			if label == "" {
				label = "动作"
			}
			filename := path.Base(strings.ReplaceAll(item.File, "\\", "/"))
			for _, suffix := range []string{".motion3.json", ".motion.json"} {
				if strings.HasSuffix(strings.ToLower(filename), suffix) {
					filename = filename[:len(filename)-len(suffix)]
					break
				}
			}
			defaultLabel := label + " · " + filename
			result.Motions = append(result.Motions, Motion{ID: string(id), Group: group, Index: index, Label: displayName(ch.ActionNames.Motions, string(id), defaultLabel), DefaultLabel: defaultLabel})
		}
	}
	for _, item := range manifest.FileReferences.Expressions {
		if item.Name != "" && exists(item.File) {
			result.Expressions = append(result.Expressions, NativeExpression{ID: item.Name, Label: displayName(ch.ActionNames.Expressions, item.Name, item.Name), DefaultLabel: item.Name})
		} else {
			result.UnavailableExpressions++
		}
	}
	return result, nil
}

func displayName(names map[string]string, id, fallback string) string {
	if name := strings.TrimSpace(names[id]); name != "" {
		return name
	}
	return fallback
}
