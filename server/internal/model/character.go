// Package model 定义 Live2D Studio 的持久化实体，供 GORM 迁移与业务层共用。
package model

import "time"

// Character 是可对话的 Live2D 角色，也是模型目录、会话与记忆的归属主体。
type Character struct {
	// ID 是稳定的角色标识（如 mao、shizuku），同时用作导入模型的目录名。
	ID          string `gorm:"primaryKey;size:64" json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	// ModelPath 是前端加载 .model3.json 的 URL，本地导入的模型以 /models/ 开头。
	ModelPath string `json:"model_path"`
	// SystemPrompt 是该角色的人设提示词，会拼接到每次对话的系统消息中。
	SystemPrompt string `json:"system_prompt"`
	// Color 是界面展示该角色时使用的主色。
	Color     string    `json:"color"`
	CreatedAt time.Time `json:"created_at"`
}
