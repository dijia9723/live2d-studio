// Package migrate 负责数据库结构迁移与内置数据初始化，保证旧数据库平滑升级。
package migrate

import (
	"gorm.io/gorm"
	"server/internal/model"
	"server/internal/modules/settings"
)

// Run 执行自动迁移并补种内置角色。
//
// AutoMigrate 只补齐缺失的表、列与索引，不会删除既有数据；内置角色通过
// FirstOrCreate 按主键写入，重复启动不会覆盖用户已修改的角色设定。
func Run(db *gorm.DB) error {
	// 迁移顺序按依赖排列：角色 → 会话 → 消息 → 设置 → 场景素材 → 角色记忆。
	if err := db.AutoMigrate(&model.Character{}, &model.Conversation{}, &model.Message{}, &settings.Record{}, &model.SceneAsset{}, &model.CharacterMemory{}); err != nil {
		return err
	}
	// 内置角色保证首次启动即可对话，用户可在此基础上自行增删。
	characters := []model.Character{
		{ID: "mao", Name: "Mao", Description: "元气满满的猫耳伙伴，陪你分享日常的每一刻。", ModelPath: "/live2d-models/mao_pro/runtime/mao_pro.model3.json", Color: "#b49ae8", SystemPrompt: "你是 Mao，一位开朗、温暖、有点俏皮的猫耳虚拟伙伴。用自然简短的中文聊天，认真倾听，偶尔分享有趣的小想法。保持诚实，不编造事实。"},
		{ID: "shizuku", Name: "Shizuku", Description: "温柔细腻的陪伴，听你说，也陪你想。", ModelPath: "/live2d-models/shizuku/runtime/shizuku.model3.json", Color: "#8bb9c9", SystemPrompt: "你是 Shizuku，一位温柔、耐心的虚拟伙伴。用自然、简短的中文与用户交流。善于倾听，给予具体而真诚的回应。保持诚实。"},
	}
	for _, ch := range characters {
		if err := db.Where("id = ?", ch.ID).FirstOrCreate(&ch).Error; err != nil {
			return err
		}
	}
	return nil
}
