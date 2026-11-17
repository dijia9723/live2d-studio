package model

import "time"

type Character struct {
	ID           string    `gorm:"primaryKey;size:64" json:"id"`
	Name         string    `json:"name"`
	Description  string    `json:"description"`
	ModelPath    string    `json:"model_path"`
	SystemPrompt string    `json:"system_prompt"`
	Color        string    `json:"color"`
	CreatedAt    time.Time `json:"created_at"`
}
