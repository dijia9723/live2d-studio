// 本文件实现发送给模型的历史裁剪：按字节预算保留连续的最新若干轮对话。

package conversation

import (
	"context"
	"unicode/utf8"

	"server/internal/model"
)

const (
	maxMessageTextBytes  = 32000
	maxMessageImageBytes = 4 << 20

	// 为四条最大长度的用户消息或两条超长回复预留空间；
	// 单条最多占用预算的一半，保证最新的这一轮一定能放进去。
	maxHistoryTextBytes  = 4 * maxMessageTextBytes
	maxHistoryEntryBytes = maxHistoryTextBytes / 2
	// 允许两条最大尺寸附件的 base64 编码体积，或更多较小的附件。
	maxHistoryImageBytes = 2 * (((maxMessageImageBytes+2)/3)*4 + len("data:image/jpeg;base64,"))

	imageOmitted = "\n[这条历史消息的图片未发送给模型]"
	textOmitted  = "\n[这条历史消息的后续文字已省略]"
)

type contextCandidate struct {
	ID         string
	Role       string
	TextBytes  int
	ImageBytes int
}

// recentContext 返回最近 limit 条可发送的历史消息，并按文本与图片字节预算裁剪。
// 先用 SQL 只查询内容长度而不加载附件，避免把大图片读进内存；
// 预算按“轮”成对保留：助手回复必须与其对应的用户消息同时放得下，
// 失败轮次留下的用户消息则可以单独保留。最终只加载选中行的前
// maxHistoryEntryBytes+1 字节，多出的一字节用于检测并触发截断。
func (s *Service) recentContext(ctx context.Context, conversationID string, limit int) ([]model.Message, error) {
	db := s.DB.WithContext(ctx)
	// 先按长度决定发送范围，再加载附件数据。
	var recent []contextCandidate
	err := db.Model(&model.Message{}).
		Select(`id, role,
			length(CAST(coalesce(content, '') AS BLOB)) AS text_bytes,
			length(CAST(coalesce(image, '') AS BLOB)) AS image_bytes`).
		Where("conversation_id = ? AND status = ? AND role IN ?", conversationID, "complete", []string{"user", "assistant"}).
		Order("created_at DESC, rowid DESC").Limit(limit).Scan(&recent).Error
	if err != nil {
		return nil, err
	}

	// 只保留连续的历史后缀：回复与它对应的用户消息必须都放得下，
	// 而失败轮次留下的用户消息可以单独保留。
	remainingText := maxHistoryTextBytes
	end := 0
	for end < len(recent) {
		next := end + 1
		if recent[end].Role == "assistant" {
			if next == len(recent) || recent[next].Role != "user" {
				break
			}
			next++
		}
		cost := 0
		for _, item := range recent[end:next] {
			textBytes := item.TextBytes
			if item.ImageBytes > 0 {
				textBytes += len(imageOmitted)
			}
			cost += min(textBytes, maxHistoryEntryBytes)
		}
		if cost > remainingText {
			break
		}
		remainingText -= cost
		end = next
	}
	if end == 0 {
		return nil, nil
	}

	ids := make([]string, 0, end)
	var imageIDs []string
	omittedImages := make(map[string]bool)
	remainingImages := maxHistoryImageBytes
	for _, item := range recent[:end] {
		ids = append(ids, item.ID)
		if item.ImageBytes > remainingImages {
			omittedImages[item.ID] = true
		} else if item.ImageBytes > 0 {
			imageIDs = append(imageIDs, item.ID)
			remainingImages -= item.ImageBytes
		}
	}

	var history []model.Message
	// 多读一字节，供 boundedContextText 判断内容是否被截断。
	err = db.Model(&model.Message{}).
		Select(`id, role, CAST(substr(CAST(content AS BLOB), 1, ?) AS TEXT) AS content,
			CASE WHEN id IN ? THEN image ELSE '' END AS image`, maxHistoryEntryBytes+1, imageIDs).
		Where("id IN ?", ids).Order("created_at ASC, rowid ASC").Find(&history).Error
	if err != nil {
		return nil, err
	}
	for i := range history {
		history[i].Content = boundedContextText(history[i].Content, omittedImages[history[i].ID])
	}
	return history, nil
}

// boundedContextText 把单条历史截断到预算内并追加省略说明；
// 截断点会回退到 UTF-8 字符起始位置，避免产生非法字节序列。
func boundedContextText(text string, omitImage bool) string {
	var note string
	if omitImage {
		note = imageOmitted
	}
	if len(text)+len(note) <= maxHistoryEntryBytes {
		return text + note
	}
	end := maxHistoryEntryBytes - len(note) - len(textOmitted)
	for !utf8.RuneStart(text[end]) {
		end--
	}
	return text[:end] + textOmitted + note
}
