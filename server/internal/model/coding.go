package model

import "time"

type CodingProject struct {
	ID        string    `gorm:"primaryKey" json:"id"`
	Name      string    `json:"name"`
	Path      string    `gorm:"uniqueIndex" json:"path"`
	CreatedAt time.Time `json:"created_at"`
}

type CodingSession struct {
	ID        string    `gorm:"primaryKey" json:"id"`
	ProjectID string    `gorm:"index" json:"project_id"`
	Title     string    `json:"title"`
	Archived  bool      `gorm:"not null;default:false" json:"archived"`
	ModelProvider string `gorm:"not null;default:''" json:"model_provider,omitempty"`
	ModelName string `gorm:"not null;default:''" json:"model_name,omitempty"`
	UpdatedAt time.Time `json:"updated_at"`
}

type CodingMessage struct {
	ID        uint64          `gorm:"primaryKey" json:"id"`
	SessionID string          `gorm:"index" json:"session_id"`
	Role      string          `json:"role"`
	Content   string          `json:"content"`
	Status    string          `json:"status"`
	Error     string          `json:"error,omitempty"`
	Tools     []CodingToolRun `gorm:"serializer:json;type:text" json:"tools,omitempty"`
	CreatedAt time.Time       `json:"created_at"`
}

type CodingToolRun struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type CodingEnhancements struct {
	ID          uint `gorm:"primaryKey" json:"-"`
	Titles      bool `json:"titles"`
	ModelTitles bool `json:"model_titles"`
	Suggestions bool `json:"suggestions"`
	Rewrite     bool `json:"rewrite"`
	Recall      bool `json:"recall"`
	MemoryWrite bool `json:"memory_write"`
}

type CodingMemory struct {
	ID        string    `gorm:"primaryKey" json:"id"`
	ProjectID string    `gorm:"index" json:"project_id"`
	Content   string    `json:"content"`
	UpdatedAt time.Time `json:"updated_at"`
}
