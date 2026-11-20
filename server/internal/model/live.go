package model

import "time"

type LiveSession struct {
	ID            string     `gorm:"primaryKey" json:"id"`
	Room          string     `json:"room"`
	Title         string     `json:"title"`
	CharacterName string     `json:"character_name"`
	StartedAt     time.Time  `gorm:"index" json:"started_at"`
	EndedAt       *time.Time `json:"ended_at,omitempty"`
	Status        string     `json:"status"`
	Incomplete    bool       `json:"incomplete"`
	Summary       string     `json:"summary,omitempty"`
}

type LiveEvent struct {
	SessionID string    `gorm:"primaryKey" json:"-"`
	ID        int       `gorm:"primaryKey;autoIncrement:false" json:"id"`
	Kind      string    `json:"kind"`
	Viewer    string    `json:"viewer"`
	Text      string    `json:"text,omitempty"`
	Count     uint64    `json:"count"`
	At        time.Time `json:"at"`
}

type LiveReply struct {
	SessionID string    `gorm:"primaryKey" json:"-"`
	ID        int       `gorm:"primaryKey;autoIncrement:false" json:"id"`
	Text      string    `json:"text,omitempty"`
	Error     string    `json:"error,omitempty"`
	EventIDs  []int     `gorm:"serializer:json" json:"event_ids"`
	At        time.Time `json:"at"`
}
