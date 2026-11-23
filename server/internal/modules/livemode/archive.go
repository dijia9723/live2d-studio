// archive.go 负责把直播过程写入数据库归档，并在结束后结算记录。

package livemode

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"server/internal/model"
)

// updateConnection 处理连接状态变化。
// 确认下播时先结算归档；进入直播态且尚无归档时新建一场记录，
// 并清空上一场的内存窗口，防止重连或换场后统计串场。
func (s *Service) updateConnection(run *session, room string, status connection) {
	run.status = status
	if status.offline || (run.archive != nil && run.archive.EndedAt != nil) {
		if err := s.finishArchive(run); err != nil {
			run.archiveError = err.Error()
			return
		}
	}
	if status.Phase != "connecting" && status.Phase != "live" {
		return
	}
	if run.archive == nil {
		row := model.LiveSession{
			ID: uuid.NewString(), Room: room, Title: limitText(status.Title, 150),
			CharacterName: run.character.Name, StartedAt: time.Now(), Status: "recording",
			Incomplete: run.missedEvents,
		}
		if err := s.db.Create(&row).Error; err != nil {
			s.archiveWriteFailed(run)
			return
		}
		run.archive, run.archiveError = &row, ""
		run.missedEvents = false
		if row.Incomplete {
			s.archiveWriteFailed(run)
		}
		run.events, run.recentChats, run.replies = nil, nil, nil
		clear(run.counts)
		clear(run.replied)
		clear(run.recentKeys)
		run.keyOrder = nil
		run.lastReplyAt = time.Time{}
		return
	}
	if title := limitText(status.Title, 150); title != "" && title != run.archive.Title {
		if err := s.db.Model(run.archive).Update("title", title).Error; err != nil {
			s.archiveWriteFailed(run)
			return
		}
		run.archive.Title = title
	}
}

// archiveWriteFailed 记录一次归档写入失败。数据库异常通常不会自行恢复，
// 这里只把整场直播标记为不完整并提示用户，而不是中断正在进行的直播。
func (s *Service) archiveWriteFailed(run *session) {
	if run.archive != nil && !run.archive.Incomplete {
		run.archive.Incomplete = true
		_ = s.db.Model(run.archive).Update("incomplete", true).Error
	}
	run.archiveError = "部分直播数据保存失败，请检查本地数据库"
}

// finishArchive 结束并结算当前归档，同时取消仍在进行的 AI 回复。
// 结算失败时保留 run.archive，调用方可稍后重试，避免丢失这场直播记录。
func (s *Service) finishArchive(run *session) error {
	if run.archive == nil {
		return nil
	}
	if run.stopReply != nil {
		run.stopReply()
	}
	row := run.archive
	if row.EndedAt == nil {
		now := time.Now()
		row.EndedAt = &now
	}
	if err := s.db.Model(row).Updates(map[string]any{
		"status": "ended", "ended_at": row.EndedAt, "incomplete": row.Incomplete,
	}).Error; err != nil {
		slog.Error("保存直播结束时间失败", "error", err)
		return errors.New("直播记录暂时无法结算，请检查本地数据库")
	}
	run.archive = nil
	return nil
}

const archivePageSize = 20

// archivePage 是直播归档列表的一页，HasMore 用于前端继续翻页。
type archivePage struct {
	Sessions []model.LiveSession `json:"sessions"`
	HasMore  bool                `json:"has_more"`
}

// archives 分页读取直播记录。多查一条用于判断是否还有下一页，
// 同时省略体积较大的总结字段，避免列表接口返回过多数据。
func (s *Service) archives(ctx context.Context, page int) (archivePage, error) {
	rows := make([]model.LiveSession, 0, archivePageSize+1)
	err := s.db.WithContext(ctx).Omit("summary").Order("started_at DESC, id DESC").
		Limit(archivePageSize + 1).Offset(page * archivePageSize).Find(&rows).Error
	return archivePage{Sessions: rows[:min(len(rows), archivePageSize)], HasMore: len(rows) > archivePageSize}, err
}

// giftTotal 是某一礼物在整场直播中的累计数量。
type giftTotal struct {
	Name  string `json:"name"`
	Count uint64 `json:"count"`
}

// archiveDetails 是单场直播的复盘详情，统计值来自数据库聚合而非内存窗口，
// 因此不受内存事件上限裁剪的影响。
type archiveDetails struct {
	model.LiveSession
	Counts        map[string]uint64 `json:"counts"`
	ReplyCount    int64             `json:"reply_count"`
	FailedReplies int64             `json:"failed_replies"`
	Gifts         []giftTotal       `json:"gifts"`
}

// archiveDetails 读取单场直播的基础信息、分类统计、回复情况与礼物排行。
func (s *Service) archiveDetails(ctx context.Context, id string) (archiveDetails, error) {
	db := s.db.WithContext(ctx)
	detail := archiveDetails{Counts: make(map[string]uint64), Gifts: make([]giftTotal, 0)}
	if err := db.First(&detail.LiveSession, "id = ?", id).Error; err != nil {
		return detail, err
	}
	var totals []struct {
		Kind  string
		Count uint64
	}
	if err := db.Model(&model.LiveEvent{}).Where("session_id = ?", id).
		Select("kind, SUM(count) AS count").Group("kind").Scan(&totals).Error; err != nil {
		return detail, err
	}
	for _, total := range totals {
		detail.Counts[total.Kind] = total.Count
	}
	if err := db.Model(&model.LiveReply{}).Where("session_id = ? AND error = ''", id).Count(&detail.ReplyCount).Error; err != nil {
		return detail, err
	}
	if err := db.Model(&model.LiveReply{}).Where("session_id = ? AND error <> ''", id).Count(&detail.FailedReplies).Error; err != nil {
		return detail, err
	}
	err := db.Model(&model.LiveEvent{}).Where("session_id = ? AND kind = ?", id, Gift).
		Select("text AS name, SUM(count) AS count").Group("text").Order("count DESC, name").Limit(10).Scan(&detail.Gifts).Error
	return detail, err
}
