// 本文件覆盖对话上下文构造：历史条数上限、按完整轮次截断、图片与超长回复
// 的安全裁剪，以及历史排序索引的迁移。

package tests

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"server/internal/bootstrap"
	"server/internal/config"
	"server/internal/model"
)

// TestChatSendsBoundedHistoryAndPreservesCurrentInput 校验上下文总字节数受控、
// 旧图片明确省略、超长回复被安全裁剪，且当前输入与已存记录不被改写。
func TestChatSendsBoundedHistoryAndPreservesCurrentInput(t *testing.T) {
	images := make([]string, 4)
	for i := range images {
		encoded := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{byte(i)}, 4<<20))
		images[i] = "data:image/jpeg;base64," + encoded
	}
	longReply := strings.Repeat("片段🌸", 10000) + "旧回复结尾"
	current := strings.Repeat("今", 10666) + "!!"
	previousRequest := strings.Repeat("中", 10666)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		messages := contextPrompt(t, r)
		if len(messages) == 9 {
			wantRoles := []string{"system", "user", "assistant", "user", "assistant", "user", "assistant", "user", "user"}
			wantText := map[int]string{2: "第一张回复", 3: previousRequest, 5: "最近的图片", 6: "最近的回复", 7: "失败前的用户消息", 8: current}
			wantImages := map[int]string{3: images[1], 5: images[2], 8: images[3]}
			var historyBytes int
			for i, message := range messages {
				if message.Role != wantRoles[i] {
					t.Errorf("message %d has role %q, want %q", i, message.Role, wantRoles[i])
				}
				if i == 0 {
					continue
				}
				if expected, ok := wantText[i]; ok && message.Text != expected {
					t.Errorf("message %d content changed (got %d bytes, want %d)", i, len(message.Text), len(expected))
				}
				if message.Image != wantImages[i] {
					t.Errorf("message %d did not receive its expected image context", i)
				}
				if i < len(messages)-1 {
					historyBytes += len(message.Text)
				}
			}
			if first := messages[1].Text; !strings.HasPrefix(first, "第一张图片") || !strings.Contains(first, "图片未发送") {
				t.Errorf("older image omission is not clear: %q", first)
			}
			clipped := messages[4].Text
			if strings.Contains(clipped, "旧回复结尾") || !strings.HasSuffix(clipped, "后续文字已省略]") || !utf8.ValidString(clipped) || len(clipped) > 64000 || strings.ContainsRune(clipped, utf8.RuneError) {
				t.Errorf("oversized reply was not safely clipped (%d bytes)", len(clipped))
			}
			if historyBytes > 128000 {
				t.Errorf("history consumes %d bytes", historyBytes)
			}
		} else {
			t.Errorf("unexpected number of upstream messages: %d", len(messages))
		}
		finishContextReply(w)
	}))
	defer upstream.Close()
	app := newApp(t)
	configure(t, app, upstream.URL, false)
	conv := conversation(t, app)
	messages := []model.Message{
		{Role: "user", Content: strings.Repeat("旧", 10000)},
		{Role: "assistant", Content: strings.Repeat("旧", 14000)},
		{Role: "user", Content: "第一张图片", Image: images[0]},
		{Role: "assistant", Content: "第一张回复"},
		{Role: "user", Content: previousRequest, Image: images[1]},
		{Role: "assistant", Content: longReply},
		{Role: "user", Content: "最近的图片", Image: images[2]},
		{Role: "assistant", Content: "最近的回复"},
		{Role: "user", Content: "失败前的用户消息"},
		{Role: "assistant", Content: "不应作为上下文的中断回复", Status: "interrupted"},
	}
	seedContextMessages(t, app, conv.ID, messages)
	stream := request(t, app, http.MethodPost, "/conversations/"+conv.ID+"/messages", map[string]string{"text": current, "image": images[3]})
	if stream.Code != 200 || !bytes.Contains(stream.Body.Bytes(), []byte(`"type":"done"`)) || bytes.Contains(stream.Body.Bytes(), []byte(`"type":"error"`)) {
		t.Fatalf("chat did not finish successfully (HTTP %d)", stream.Code)
	}
	var stored []model.Message
	if err := app.DB.Where("id IN ?", []string{messages[2].ID, messages[5].ID}).Order("created_at ASC, rowid ASC").Find(&stored).Error; err != nil {
		t.Fatal(err)
	}
	if len(stored) != 2 || stored[0].Image != images[0] || stored[0].Content != messages[2].Content || stored[1].Content != longReply {
		t.Fatal("context selection altered the saved transcript")
	}
}

// TestChatContextMessageLimitKeepsWholeTurns 校验按条数限制历史时不会拆散问答轮次。
func TestChatContextMessageLimitKeepsWholeTurns(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		messages := contextPrompt(t, r)
		if len(messages) != 4 || messages[1].Role != "user" || messages[1].Text != "最近的问题" || messages[2].Role != "assistant" || messages[2].Text != "最近的回复" || messages[3].Text != "新的问题" {
			t.Errorf("unexpected upstream history: %+v", messages)
		}
		finishContextReply(w)
	}))
	defer upstream.Close()
	app := newApp(t)
	cfg := config.Defaults().Settings
	cfg.LLM.BaseURL = upstream.URL + "/v1"
	cfg.LLM.ContextMessages = 3
	if response := request(t, app, http.MethodPut, "/settings", cfg); response.Code != 200 {
		t.Fatal(response.Body)
	}
	conv := conversation(t, app)
	seedContextMessages(t, app, conv.ID, []model.Message{
		{Role: "user", Content: "旧的问题"},
		{Role: "assistant", Content: "旧的回复"},
		{Role: "user", Content: "最近的问题"},
		{Role: "assistant", Content: "最近的回复"},
	})
	stream := request(t, app, http.MethodPost, "/conversations/"+conv.ID+"/messages", map[string]string{"text": "新的问题"})
	if stream.Code != 200 || strings.Contains(stream.Body.String(), `"type":"error"`) || !strings.Contains(stream.Body.String(), `"type":"done"`) {
		t.Fatal(stream.Body)
	}
}

// TestConversationOrderIndexMigratesExistingHistory 校验旧数据库升级后会补建
// 会话排序索引，且既有聊天记录（含图片）保持完整。
func TestConversationOrderIndexMigratesExistingHistory(t *testing.T) {
	const index = "idx_messages_conversation_order"
	old := newApp(t)
	if err := old.DB.Migrator().DropIndex(&model.Message{}, index); err != nil {
		t.Fatal(err)
	}
	conv := conversation(t, old)
	seedContextMessages(t, old, conv.ID, []model.Message{
		{Role: "user", Content: "以前的问题", Image: "data:image/png;base64,YQ=="},
		{Role: "assistant", Content: "以前的回复"},
	})
	old.Close()

	app, err := bootstrap.New(old.Config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	if !app.DB.Migrator().HasIndex(&model.Message{}, index) {
		t.Fatal("existing database did not receive the conversation index")
	}
	stored := decode[[]model.Message](t, request(t, app, http.MethodGet, "/conversations/"+conv.ID+"/messages", nil))
	if len(stored) != 2 || stored[0].Content != "以前的问题" || stored[0].Image != "data:image/png;base64,YQ==" || stored[1].Content != "以前的回复" {
		t.Fatalf("existing history changed during migration: %+v", stored)
	}
	var plan []struct{ Detail string }
	if err := app.DB.Raw(`EXPLAIN QUERY PLAN
		SELECT id, role, length(CAST(image AS BLOB))
		FROM messages WHERE conversation_id = ? AND status = 'complete' AND role IN ('user', 'assistant')
		ORDER BY created_at DESC, rowid DESC LIMIT 40`, conv.ID).Scan(&plan).Error; err != nil {
		t.Fatal(err)
	}
	t.Logf("history query plan: %v", plan)
}

// contextPromptMessage 是测试侧简化后的上游消息视图。
type contextPromptMessage struct {
	Role  string
	Text  string
	Image string
}

// contextPrompt 解析上游收到的消息，兼容纯文本与多段（文本+图片）两种内容格式。
func contextPrompt(t *testing.T, r *http.Request) []contextPromptMessage {
	t.Helper()
	var body struct {
		Messages []struct {
			Role    string
			Content json.RawMessage
		}
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		t.Error(err)
		return nil
	}
	messages := make([]contextPromptMessage, len(body.Messages))
	for i, message := range body.Messages {
		messages[i].Role = message.Role
		if bytes.HasPrefix(message.Content, []byte("[")) {
			var parts []struct {
				Type     string
				Text     string
				ImageURL struct{ URL string } `json:"image_url"`
			}
			if err := json.Unmarshal(message.Content, &parts); err != nil {
				t.Error(err)
				continue
			}
			for _, part := range parts {
				switch part.Type {
				case "text":
					messages[i].Text = part.Text
				case "image_url":
					messages[i].Image = part.ImageURL.URL
				}
			}
		} else if err := json.Unmarshal(message.Content, &messages[i].Text); err != nil {
			t.Error(err)
		}
	}
	return messages
}

// finishContextReply 让模拟上游立即结束一轮流式回复。
func finishContextReply(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/event-stream")
	chunk(w, map[string]any{"role": "assistant", "content": "收到"}, "stop")
	fmt.Fprint(w, "data: [DONE]\n\n")
}

// seedContextMessages 批量写入历史消息，并规范化 ID、会话归属与默认状态。
func seedContextMessages(t *testing.T, app *bootstrap.App, conversationID string, messages []model.Message) {
	t.Helper()
	for i := range messages {
		message := &messages[i]
		message.ID = fmt.Sprintf("%s-history-%d", conversationID, i)
		message.ConversationID = conversationID
		// 导入或历史数据可能共用同一时间戳，因此还要依赖 rowid 保持写入顺序。
		message.CreatedAt = time.Unix(1, 0)
		if message.Status == "" {
			message.Status = "complete"
		}
	}
	if err := app.DB.Create(&messages).Error; err != nil {
		t.Fatal(err)
	}
}
