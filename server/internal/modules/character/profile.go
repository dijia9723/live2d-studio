// 本文件实现角色设定的局部更新与校验，供智能体工具使用。
package character

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"server/internal/model"

	"gorm.io/gorm"
)

// ErrProfile 表示工具输入缺失或角色资料超出编辑器允许的范围。
var ErrProfile = errors.New("请至少提供一项角色设定：名称不能为空且最多 100 字节，介绍最多 200 个字符，人设最多 24000 字节。")

// ProfilePatch 的 nil 字段保持不变；空字符串可显式清除介绍或人设。
type ProfilePatch struct {
	Name         *string `json:"name,omitempty" jsonschema:"description=新的角色名称，不能为空，最多 100 字节；不修改时省略"`
	Description  *string `json:"description,omitempty" jsonschema:"description=新的自我介绍，最多 200 个字符；空字符串清除介绍，不修改时省略"`
	SystemPrompt *string `json:"system_prompt,omitempty" jsonschema:"description=完整的新角色人设（替换原人设），最多 24000 字节；保留用户未要求改变的设定，不修改时省略"`
}

// PatchProfile 只写入明确提供的字段，避免多次工具调用互相覆盖其它角色资料。
func (s *Service) PatchProfile(ctx context.Context, id string, patch ProfilePatch) (model.Character, error) {
	values := map[string]any{}
	if patch.Name != nil {
		name := strings.TrimSpace(*patch.Name)
		if name == "" || len(name) > 100 {
			return model.Character{}, ErrProfile
		}
		values["name"] = name
	}
	if patch.Description != nil {
		text := strings.TrimSpace(*patch.Description)
		if utf8.RuneCountInString(text) > 200 {
			return model.Character{}, ErrProfile
		}
		values["description"] = text
	}
	if patch.SystemPrompt != nil {
		text := strings.TrimSpace(*patch.SystemPrompt)
		if len(text) > 24000 {
			return model.Character{}, ErrProfile
		}
		values["system_prompt"] = text
	}
	if len(values) == 0 {
		return model.Character{}, ErrProfile
	}
	var result model.Character
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.First(&result, "id = ?", id).Error; err != nil {
			return err
		}
		if err := tx.Model(&model.Character{}).Where("id = ?", id).Updates(values).Error; err != nil {
			return err
		}
		return tx.First(&result, "id = ?", id).Error
	})
	return result, err
}
