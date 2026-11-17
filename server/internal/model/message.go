package model

import "time"

type Message struct {
	ID             string    `gorm:"primaryKey;size:64" json:"id"`
	ConversationID string    `gorm:"index" json:"conversation_id"`
	Role           string    `json:"role"`
	Content        string    `json:"content"`
	Image          string    `json:"image,omitempty"`
	Status         string    `json:"status"`
	Error          string    `json:"error,omitempty"`
	CreatedAt      time.Time `gorm:"index" json:"created_at"`
}
