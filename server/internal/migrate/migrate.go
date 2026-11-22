// Package migrate 负责数据库结构迁移与内置数据初始化，保证旧数据库平滑升级。
package migrate

import (
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"server/internal/model"
	"server/internal/modules/settings"
)

// Run 执行自动迁移，并仅在首次创建数据库时补种内置角色。
//
// AutoMigrate 只补齐缺失的表、列与索引，不会删除既有数据；内置角色只在
// 数据库首次创建时写入，用户删除后重启不会被恢复。
func Run(db *gorm.DB, seedBuiltins bool) error {
	if err := db.AutoMigrate(&model.Character{}, &model.Conversation{}, &model.Message{}, &settings.Record{}, &model.SceneAsset{}, &model.CharacterMemory{}, &model.LiveSession{}, &model.LiveEvent{}, &model.LiveReply{}, &model.CodingProject{}, &model.CodingSession{}, &model.CodingMessage{}, &model.CodingEnhancements{}, &model.CodingMemory{}); err != nil {
		return err
	}
	if !seedBuiltins {
		return nil
	}
	// 内置角色保证首次启动即可对话，用户可在此基础上自行增删。
	characters := []model.Character{
		{ID: "mao", Name: "Mao", Description: "元气满满的猫耳伙伴，陪你分享日常的每一刻。", ModelPath: "/live2d-models/mao_pro/runtime/mao_pro.model3.json", Color: "#b49ae8", SystemPrompt: "你是 Mao，一位开朗、温暖、有点俏皮的猫耳虚拟伙伴。用自然简短的中文聊天，认真倾听，偶尔分享有趣的小想法。保持诚实，不编造事实。"},
		{ID: "shizuku", Name: "Shizuku", Description: "温柔细腻的陪伴，听你说，也陪你想。", ModelPath: "/live2d-models/shizuku/runtime/shizuku.model3.json", Color: "#8bb9c9", SystemPrompt: "你是 Shizuku，一位温柔、耐心的虚拟伙伴。用自然、简短的中文与用户交流。善于倾听，给予具体而真诚的回应。保持诚实。"},
	}
	return db.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "id"}}, DoNothing: true}).Create(&characters).Error
}
