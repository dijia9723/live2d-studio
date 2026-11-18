// 本文件持久化模型动作命名；改名不会修改模型文件或底层调用 ID。
package character

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	"gorm.io/gorm"
	"server/internal/model"
)

var ErrActionNames = errors.New("命名配置无效：请使用当前模型中的动作或表情，名称最多 60 个字符且不能包含换行等控制字符。模型变化后请重新打开配置。")

type ActionNamesRequest struct {
	ModelPath string             `json:"model_path"`
	Names     *model.ActionNames `json:"action_names"`
}

// SaveActionNames 全量替换命名，空名称或省略项恢复默认。只更新命名列，保留其它角色设定。
func (s *Service) SaveActionNames(ctx context.Context, id string, request ActionNamesRequest) (model.Character, error) {
	catalog, err := s.Actions(ctx, id)
	if err != nil {
		return model.Character{}, err
	}
	if request.Names == nil || request.ModelPath != catalog.ModelPath || len(request.Names.Motions)+len(request.Names.Expressions)+len(request.Names.Moods) > 4096 {
		return model.Character{}, ErrActionNames
	}
	allowedMotions := map[string]string{}
	for key := range catalog.ActionNames.Motions {
		allowedMotions[normalizeMotionID(key)] = key
	}
	for _, motion := range catalog.Motions {
		allowedMotions[normalizeMotionID(motion.ID)] = motion.ID
	}
	allowedExpressions := map[string]string{}
	for key := range catalog.ActionNames.Expressions {
		allowedExpressions[key] = key
	}
	for _, expression := range catalog.Expressions {
		allowedExpressions[expression.ID] = expression.ID
	}
	allowedMoods := map[string]string{}
	for _, mood := range catalog.Moods {
		allowedMoods[mood.ID] = mood.ID
	}
	clean := func(input map[string]string, allowed map[string]string, motion bool) (map[string]string, error) {
		output := map[string]string{}
		for key, value := range input {
			value = strings.TrimSpace(value)
			if value == "" {
				continue
			}
			if motion {
				key = normalizeMotionID(key)
			}
			canonical, ok := allowed[key]
			if !ok || utf8.RuneCountInString(value) > 60 || strings.ContainsFunc(value, unicode.IsControl) {
				return nil, ErrActionNames
			}
			if _, duplicate := output[canonical]; duplicate {
				return nil, ErrActionNames
			}
			output[canonical] = value
		}
		return output, nil
	}
	names := model.ActionNames{}
	if names.Motions, err = clean(request.Names.Motions, allowedMotions, true); err != nil {
		return model.Character{}, err
	}
	if names.Expressions, err = clean(request.Names.Expressions, allowedExpressions, false); err != nil {
		return model.Character{}, err
	}
	if names.Moods, err = clean(request.Names.Moods, allowedMoods, false); err != nil {
		return model.Character{}, err
	}
	var saved model.Character
	err = s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		update := tx.Model(&model.Character{}).Where("id = ? AND model_path = ?", id, request.ModelPath).Select("ActionNames").Updates(&model.Character{ActionNames: names})
		if update.Error != nil {
			return update.Error
		}
		if update.RowsAffected == 0 {
			return ErrActionNames
		}
		return tx.First(&saved, "id = ?", id).Error
	})
	return saved, err
}

func normalizeMotionID(id string) string {
	var parts []json.RawMessage
	var group *string
	var index *int
	if json.Unmarshal([]byte(id), &parts) != nil || len(parts) != 2 || json.Unmarshal(parts[0], &group) != nil || json.Unmarshal(parts[1], &index) != nil || group == nil || index == nil {
		return ""
	}
	canonical, _ := json.Marshal([]any{*group, *index})
	return string(canonical)
}
