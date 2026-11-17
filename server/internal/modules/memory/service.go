// 本文件实现角色记忆的持久化、去重、容量限制与按角色的隔离查询。

package memory

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"server/internal/model"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

const (
	maxMemories = 100
	maxContent  = 300
	// recentLimit 是注入系统提示词的最近记忆条数，远小于 maxMemories，避免挤占上下文预算。
	recentLimit = 8
)

var (
	// ErrContent 表示记忆内容为空白、非法 UTF-8 或超过 300 个字符。
	ErrContent = errors.New("记忆内容须为 1–300 个字符")
	// ErrLimit 表示单个角色的记忆数量已达上限。
	ErrLimit = errors.New("此角色已保存 100 条记忆")
	// ErrExists 表示同一角色下已存在完全相同的记忆内容。
	ErrExists = errors.New("此角色已有相同的记忆")
)

// Service 负责角色记忆的持久化；所有读写都按角色 ID 限定，避免跨角色访问。
type Service struct{ DB *gorm.DB }

// List 返回指定角色的全部记忆（最多 maxMemories 条），角色不存在时返回错误。
func (s *Service) List(ctx context.Context, characterID string) ([]model.CharacterMemory, error) {
	if err := requireCharacter(s.DB.WithContext(ctx), characterID); err != nil {
		return nil, err
	}
	return s.list(ctx, characterID, maxMemories)
}

// Recent 返回最近更新的少量记忆，供系统提示词注入使用。
func (s *Service) Recent(ctx context.Context, characterID string) ([]model.CharacterMemory, error) {
	return s.list(ctx, characterID, recentLimit)
}

// Create 在事务内校验角色存在、内容合法、去重与数量上限。
// 内容重复时返回已有记录而不报错，便于模型或前端重复保存同一条记忆。
func (s *Service) Create(ctx context.Context, characterID, content string) (model.CharacterMemory, error) {
	var memory model.CharacterMemory
	content = strings.TrimSpace(content)
	if !validContent(content) {
		return memory, ErrContent
	}
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := requireCharacter(tx, characterID); err != nil {
			return err
		}
		err := scoped(tx, characterID).Take(&memory, "content = ?", content).Error
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		var count int64
		if err := scoped(tx, characterID).Count(&count).Error; err != nil {
			return err
		}
		if count >= maxMemories {
			return ErrLimit
		}
		memory = model.CharacterMemory{ID: uuid.NewString(), CharacterID: characterID, Content: content}
		return tx.Create(&memory).Error
	})
	return memory, err
}

// Update 修改记忆内容：内容未变化时直接返回，改成同角色其它记忆的内容则返回 ErrExists。
func (s *Service) Update(ctx context.Context, characterID, id, content string) (model.CharacterMemory, error) {
	var memory model.CharacterMemory
	content = strings.TrimSpace(content)
	if !validContent(content) {
		return memory, ErrContent
	}
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := scoped(tx, characterID).Take(&memory, "id = ?", id).Error; err != nil {
			return err
		}
		if memory.Content == content {
			return nil
		}
		var count int64
		if err := scoped(tx, characterID).Where("content = ?", content).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return ErrExists
		}
		return scoped(tx, characterID).Model(&memory).Update("content", content).Error
	})
	return memory, err
}

// Delete 只在指定角色范围内删除，跨角色或不存在时返回 gorm.ErrRecordNotFound。
func (s *Service) Delete(ctx context.Context, characterID, id string) error {
	result := scoped(s.DB.WithContext(ctx), characterID).Delete(&model.CharacterMemory{}, "id = ?", id)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

// list 按更新时间倒序返回上限 limit 条记忆；角色 ID 为空时返回空列表而不是全表数据。
func (s *Service) list(ctx context.Context, characterID string, limit int) ([]model.CharacterMemory, error) {
	memories := []model.CharacterMemory{}
	if characterID == "" {
		return memories, nil
	}
	err := scoped(s.DB.WithContext(ctx), characterID).Order("updated_at DESC, id ASC").Limit(limit).Find(&memories).Error
	return memories, err
}

// scoped 把查询限定在某个角色的记忆内，是所有读写操作的统一入口。
func scoped(db *gorm.DB, characterID string) *gorm.DB {
	return db.Model(&model.CharacterMemory{}).Where("character_id = ?", characterID)
}

// requireCharacter 确认角色存在，避免为不存在的角色写入孤儿记忆。
func requireCharacter(db *gorm.DB, id string) error {
	return db.Select("id").Take(&model.Character{}, "id = ?", id).Error
}

// validContent 要求内容非空、是合法 UTF-8，并按字符数（而非字节数）限制长度。
func validContent(content string) bool {
	return content != "" && utf8.ValidString(content) && utf8.RuneCountInString(content) <= maxContent
}
