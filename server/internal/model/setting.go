package model

type Setting struct {
	ID    uint `gorm:"primaryKey"`
	Value string
}

func (Setting) TableName() string { return "records" }
