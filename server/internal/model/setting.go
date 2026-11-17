// 本文件定义通用键值记录表，历史表名固定为 records。

package model

// Setting 是 records 表中的一条键值记录，Value 通常存放序列化后的设置快照。
type Setting struct {
	ID    uint `gorm:"primaryKey"`
	Value string
}

// TableName 固定历史表名，避免给已有数据库带来重命名迁移。
func (Setting) TableName() string { return "records" }
