package livemode

import (
	"encoding/json"
	"errors"
	"net/url"
	"slices"
	"strings"
	"unicode/utf8"

	"gorm.io/gorm"
	"server/internal/model"
)

// ID 1 is used by the general Studio settings.
const configRecordID = 2

type Kind string

const (
	Chat   Kind = "chat"
	Gift   Kind = "gift"
	Like   Kind = "like"
	Enter  Kind = "enter"
	Follow Kind = "follow"
)

var kinds = []Kind{Chat, Gift, Like, Enter, Follow}

type Config struct {
	Room         string  `json:"room"`
	CharacterID  string  `json:"character_id"`
	Prompt       string  `json:"prompt"`
	Temperature  float32 `json:"temperature"`
	PollSeconds  int     `json:"poll_seconds"`
	ReplySeconds int     `json:"reply_seconds"`
	BatchSize    int     `json:"batch_size"`
	MaxTokens    int     `json:"max_tokens"`
	Mode         string  `json:"mode"`
	Events       []Kind  `json:"events"`
	ReplyEvents  []Kind  `json:"reply_events"`
	Speak        bool    `json:"speak"`
	Actions      bool    `json:"actions"`
}

func defaultConfig() Config {
	return Config{
		Prompt:      "像跟直播间的朋友聊天。有人问就先答，遇到有意思的弹幕可以顺势接个梗。收到礼物或关注时顺口谢一句。",
		Temperature: 0.7, PollSeconds: 20, ReplySeconds: 8, BatchSize: 5, MaxTokens: 256,
		Mode: "manual", Events: slices.Clone(kinds), ReplyEvents: []Kind{Chat, Gift, Follow},
		Speak: true, Actions: true,
	}
}

func roomID(value string) (string, error) {
	id := strings.TrimSpace(value)
	if strings.Contains(id, "://") {
		u, err := url.Parse(id)
		if err != nil || u.Scheme != "https" || !strings.EqualFold(u.Host, "live.douyin.com") || u.User != nil {
			return "", errors.New("请输入抖音直播间数字 ID 或 live.douyin.com 链接")
		}
		id = strings.Trim(u.Path, "/")
	}
	if id == "" || len(id) > 32 || strings.IndexFunc(id, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
		return "", errors.New("请输入抖音直播间数字 ID 或 live.douyin.com 链接")
	}
	return id, nil
}

func (c *Config) normalize() error {
	c.Room = strings.TrimSpace(c.Room)
	if c.Room != "" {
		id, err := roomID(c.Room)
		if err != nil {
			return err
		}
		c.Room = id
	}
	c.Prompt = strings.TrimSpace(c.Prompt)
	if utf8.RuneCountInString(c.Prompt) > 3000 {
		return errors.New("直播提示词最多 3000 字")
	}
	if len(c.CharacterID) > 128 {
		return errors.New("直播角色 ID 无效")
	}
	if c.Temperature < 0 || c.Temperature > 2 || c.PollSeconds < 5 || c.PollSeconds > 300 ||
		c.ReplySeconds < 2 || c.ReplySeconds > 120 || c.BatchSize < 1 || c.BatchSize > 12 ||
		c.MaxTokens < 32 || c.MaxTokens > 2048 {
		return errors.New("请检查温度、开播轮询、回复间隔、每轮条数和回复长度")
	}
	if c.Mode != "manual" && c.Mode != "auto" && c.Mode != "paused" {
		return errors.New("互动状态无效")
	}
	var enabled, replies []Kind
	for _, kind := range kinds {
		if slices.Contains(c.Events, kind) {
			enabled = append(enabled, kind)
			if slices.Contains(c.ReplyEvents, kind) {
				replies = append(replies, kind)
			}
		}
	}
	c.Events, c.ReplyEvents = enabled, replies
	return nil
}

func loadConfig(db *gorm.DB) (Config, error) {
	config := defaultConfig()
	var record model.Setting
	if err := db.First(&record, configRecordID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return config, nil
		}
		return config, err
	}
	if err := json.Unmarshal([]byte(record.Value), &config); err != nil {
		return config, err
	}
	return config, nil
}
