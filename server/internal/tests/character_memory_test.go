// 本文件覆盖角色记忆的隔离、工具检索与删除后的记忆刷新。

package tests

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"server/internal/model"
)

// TestCharacterMemoryInChatAndSearch 覆盖记忆按角色隔离、工具开关对检索的影响，
// 以及删除记忆后不再注入系统提示。
func TestCharacterMemoryInChatAndSearch(t *testing.T) {
	const note = "我喜欢抹茶蛋糕"
	const otherNote = "我喜欢蓝莓蛋糕"
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Tools    []any
			Messages []struct{ Role, Content string }
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		var prompt, user, result string
		for _, message := range body.Messages {
			switch message.Role {
			case "system":
				prompt = message.Content
			case "user":
				user = message.Content
			case "tool":
				result = message.Content
			}
		}
		wantNote := user == "开启工具时记得什么" || user == "关闭工具时记得什么"
		wantOther := user == "另一个角色记得什么"
		if strings.Contains(prompt, note) != wantNote || strings.Contains(prompt, otherNote) != wantOther {
			t.Errorf("character memories mixed across requests for %q: %s", user, prompt)
		}
		if user == "关闭工具时记得什么" && len(body.Tools) != 0 {
			t.Error("turn advertised tools with tools disabled")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if user == "开启工具时记得什么" && result == "" {
			chunk(w, map[string]any{"role": "assistant", "tool_calls": []any{
				map[string]any{"index": 0, "id": "memory", "type": "function", "function": map[string]string{"name": "search_memories", "arguments": `{"query":"蛋糕"}`}},
			}}, "tool_calls")
		} else {
			if user == "开启工具时记得什么" && (!strings.Contains(result, note) || strings.Contains(result, otherNote)) {
				t.Errorf("search_memories returned unexpected data: %s", result)
			}
			chunk(w, map[string]any{"role": "assistant", "content": "OK"}, "stop")
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer up.Close()
	app := newApp(t)
	save := func(characterID, content string) model.CharacterMemory {
		return decode[model.CharacterMemory](t, request(t, app, "POST", "/characters/"+characterID+"/memories", map[string]string{"content": content}))
	}
	maoMemory := save("mao", note)
	save("shizuku", otherNote)
	chat := func(characterID, user string) string {
		conv := decode[model.Conversation](t, request(t, app, "POST", "/conversations", map[string]string{"character_id": characterID}))
		w := request(t, app, "POST", "/conversations/"+conv.ID+"/messages", map[string]string{"text": user})
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"type":"done"`) || strings.Contains(w.Body.String(), `"type":"error"`) {
			t.Fatal(w.Body.String())
		}
		return w.Body.String()
	}
	configure(t, app, up.URL, true)
	if w := request(t, app, "POST", "/settings/test", nil); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if stream := chat("mao", "开启工具时记得什么"); !strings.Contains(stream, `"name":"search_memories","status":"completed"`) {
		t.Fatal(stream)
	}
	configure(t, app, up.URL, false)
	chat("mao", "关闭工具时记得什么")
	chat("shizuku", "另一个角色记得什么")
	if w := request(t, app, "DELETE", "/characters/mao/memories/"+maoMemory.ID, nil); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	chat("mao", "删除后记得什么")
}
