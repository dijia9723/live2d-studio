package livemode

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"server/internal/model"
)

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

func (s *Service) archiveWriteFailed(run *session) {
	if run.archive != nil && !run.archive.Incomplete {
		run.archive.Incomplete = true
		_ = s.db.Model(run.archive).Update("incomplete", true).Error
	}
	run.archiveError = "部分直播数据保存失败，请检查本地数据库"
}

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

type archivePage struct {
	Sessions []model.LiveSession `json:"sessions"`
	HasMore  bool                `json:"has_more"`
}

func (s *Service) archives(ctx context.Context, page int) (archivePage, error) {
	rows := make([]model.LiveSession, 0, archivePageSize+1)
	err := s.db.WithContext(ctx).Omit("summary").Order("started_at DESC, id DESC").
		Limit(archivePageSize + 1).Offset(page * archivePageSize).Find(&rows).Error
	return archivePage{Sessions: rows[:min(len(rows), archivePageSize)], HasMore: len(rows) > archivePageSize}, err
}

type giftTotal struct {
	Name  string `json:"name"`
	Count uint64 `json:"count"`
}

type archiveDetails struct {
	model.LiveSession
	Counts        map[string]uint64 `json:"counts"`
	ReplyCount    int64             `json:"reply_count"`
	FailedReplies int64             `json:"failed_replies"`
	Gifts         []giftTotal       `json:"gifts"`
}

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
