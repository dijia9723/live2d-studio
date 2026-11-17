// 本文件定义会话表：会话归属某个角色，并按最近活跃时间排序展示。

package model

import "time"

// Conversation 表示一段与角色的对话；标题在首条消息后生成，可被用户重命名。
type Conversation struct {
	ID string `gorm:"primaryKey;size:64" json:"id"`
	// CharacterID 关联 Character.ID，用于按角色过滤会话。
	CharacterID string    `gorm:"index" json:"character_id"`
	Title       string    `json:"title"`
	CreatedAt   time.Time `json:"created_at"`
	// UpdatedAt 建索引以支撑会话列表按活跃时间排序。
	UpdatedAt time.Time `gorm:"index" json:"updated_at"`
}
