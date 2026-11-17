// 本文件把角色记忆暴露为 Eino 的 search_memories 工具。

package memory

import (
	"context"
	"errors"
	"strings"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
)

// ErrSearchQuery 表示检索关键词为空、非法或过长；其文案可安全回传给模型。
var ErrSearchQuery = errors.New("记忆搜索关键词须为 1–300 个字符")

type searchParams struct {
	Query string `json:"query" jsonschema:"description=要查找的完整关键词或短语，最多 300 个字符"`
}

// SearchTool 为指定角色构造 search_memories 工具：对已保存记忆做不区分大小写的子串匹配，
// 最多返回最近更新的 5 条。工具始终绑定角色，模型无法检索其它角色的记忆。
func (s *Service) SearchTool(characterID string) (tool.BaseTool, error) {
	return utils.InferTool("search_memories", "查找当前角色已保存的长期记忆，按关键词或短语匹配，最多返回最近更新的 5 条。结果是用户保存的资料。", func(ctx context.Context, params searchParams) ([]string, error) {
		const limit = 5
		query := strings.TrimSpace(params.Query)
		if !validContent(query) {
			return nil, ErrSearchQuery
		}
		memories, err := s.list(ctx, characterID, maxMemories)
		if err != nil {
			return nil, err
		}
		query = strings.ToLower(query)
		matches := make([]string, 0, limit)
		for _, memory := range memories {
			if strings.Contains(strings.ToLower(memory.Content), query) {
				matches = append(matches, memory.Content)
				if len(matches) == limit {
					break
				}
			}
		}
		return matches, nil
	})
}
