// 本文件定义角色长期记忆表：记忆按角色隔离，角色删除时级联清理。

package model

import "time"

// CharacterMemory 是一条按角色隔离的长期记忆，由对话工具写入并按关键词检索。
type CharacterMemory struct {
	ID string `gorm:"primaryKey;size:64" json:"id"`
	// 与 Content 组成组合唯一索引，避免同一角色重复记住相同内容。
	CharacterID string    `gorm:"size:64;not null;uniqueIndex:idx_character_memory_content" json:"character_id"`
	Content     string    `gorm:"not null;uniqueIndex:idx_character_memory_content" json:"content"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	// Character 是级联删除所需的反向关联，不对外输出。
	Character Character `gorm:"foreignKey:CharacterID;constraint:OnDelete:CASCADE" json:"-"`
}
