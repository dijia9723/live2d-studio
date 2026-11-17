package model

import "time"

type Conversation struct {
	ID          string    `gorm:"primaryKey;size:64" json:"id"`
	CharacterID string    `gorm:"index" json:"character_id"`
	Title       string    `json:"title"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `gorm:"index" json:"updated_at"`
}
