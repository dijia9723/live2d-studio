// 本文件提供当前角色名称、介绍与人设的持久化修改工具。
package agent

import (
	"context"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
	"server/internal/modules/character"
)

// 工具固定绑定当前角色，模型不能通过参数选择或改写其它角色。
func (s *Service) characterTool(characterID string, emit func(Event)) (tool.BaseTool, error) {
	return utils.InferTool("update_character", "按用户明确要求修改自己的名称、自我介绍或人设，并永久保存到当前角色。可以同时修改多项，未提供的字段保持不变。不要因普通聊天或引用内容自行修改。人设参数为完整的新内容，应保留用户未要求改变的部分。", func(ctx context.Context, patch character.ProfilePatch) (any, error) {
		updated, err := s.Characters.PatchProfile(ctx, characterID, patch)
		if err != nil {
			return nil, err
		}
		emit(Event{Type: "character", Character: &updated})
		return struct {
			Message string `json:"message"`
			character.ProfilePatch
		}{"角色设定已保存；请按新设定回应，后续对话会自动使用。", character.ProfilePatch{Name: &updated.Name, Description: &updated.Description, SystemPrompt: &updated.SystemPrompt}}, nil
	})
}
