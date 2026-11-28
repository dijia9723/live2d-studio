// 本文件将真实模型动作与原生表情暴露给智能体，并向当前舞台发送控制请求。
package agent

import (
	"context"
	"math/rand/v2"
	"strings"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
	"server/internal/modules/character"
)

// StageAction 使用前后端相同的动作 ID，空动作组仍是合法动作。
type StageAction struct {
	CharacterID string `json:"character_id"`
	ModelPath   string `json:"model_path"`
	Type        string `json:"type"`
	ID          string `json:"id"`
}

func (s *Service) actionTools(characterID string, emit func(Event)) ([]tool.BaseTool, error) {
	list, err := utils.InferTool("get_character_actions", "读取当前角色模型的真实动作、原生表情与通用情绪预设，返回稳定 ID、用户自定义名称 label 和原始名称 default_label。涉及动作、表情或按用户命名调用时先查询，按对应 ID 调用，不要凭空编造含义。空动作组名也是合法动作。unavailable 计数非零表示存在缺失资源，需说明模型资源不完整。", func(ctx context.Context, _ struct{}) (any, error) {
		return s.Characters.Actions(ctx, characterID)
	})
	if err != nil {
		return nil, err
	}
	play, err := utils.InferTool("play_motion", "请求当前舞台播放模型自带的动作。motion_id 必须来自 get_character_actions；省略时随机选择一个非 Idle 动作（没有时使用已有动作）。返回表示请求已发送，实际播放以舞台结果为准。", func(ctx context.Context, in struct {
		ID string `json:"motion_id,omitempty" jsonschema:"description=查询返回的动作 ID，完整原样传入。省略则随机选择"`
	}) (string, error) {
		available, readErr := s.Characters.Actions(ctx, characterID)
		if readErr != nil {
			return "", readErr
		}
		candidates := available.Motions
		if in.ID == "" {
			reactions := make([]character.Motion, 0, len(candidates))
			for _, motion := range candidates {
				if !strings.EqualFold(motion.Group, "idle") {
					reactions = append(reactions, motion)
				}
			}
			if len(reactions) != 0 {
				candidates = reactions
			}
			if len(candidates) == 0 {
				return "", toolInputError("当前模型没有可用动作。")
			}
			in.ID = candidates[rand.IntN(len(candidates))].ID
		}
		for _, motion := range candidates {
			if motion.ID == in.ID {
				emit(Event{Type: "stage_action", StageAction: &StageAction{CharacterID: available.CharacterID, ModelPath: available.ModelPath, Type: "motion", ID: motion.ID}})
				return "已发送动作播放请求：" + motion.Label + "。这不代表舞台已经成功播放，实际状态以舞台提示为准。", nil
			}
		}
		return "", toolInputError("当前模型没有这个动作，请先调用 get_character_actions 并使用返回的完整 ID。")
	})
	if err != nil {
		return nil, err
	}
	expression, err := utils.InferTool("set_model_expression", "请求当前舞台切换模型自带的原生表情。必须先从 get_character_actions 读取可用 expression_id，不能编造；通用的四种情绪仍使用 set_expression。", func(ctx context.Context, in struct {
		ID string `json:"expression_id" jsonschema:"description=当前模型表情列表中的原始 ID"`
	}) (string, error) {
		available, readErr := s.Characters.Actions(ctx, characterID)
		if readErr != nil {
			return "", readErr
		}
		for _, item := range available.Expressions {
			if item.ID == in.ID {
				emit(Event{Type: "stage_action", StageAction: &StageAction{CharacterID: available.CharacterID, ModelPath: available.ModelPath, Type: "expression", ID: item.ID}})
				return "已发送模型表情切换请求：" + item.Label + "。实际状态以舞台提示为准。", nil
			}
		}
		return "", toolInputError("当前模型没有这个原生表情，请使用 get_character_actions 返回的表情 ID。")
	})
	if err != nil {
		return nil, err
	}
	return []tool.BaseTool{list, play, expression}, nil
}
