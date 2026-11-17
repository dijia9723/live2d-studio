package model

import "time"

type SceneAsset struct {
	ID        string    `gorm:"primaryKey;size:64" json:"id"`
	Name      string    `json:"name"`
	Kind      string    `gorm:"size:10" json:"kind"`
	MIMEType  string    `gorm:"size:50" json:"mime_type"`
	Size      int64     `json:"size"`
	Filename  string    `gorm:"uniqueIndex;size:80" json:"-"`
	URL       string    `gorm:"-" json:"url"`
	CreatedAt time.Time `gorm:"index" json:"created_at"`
}
