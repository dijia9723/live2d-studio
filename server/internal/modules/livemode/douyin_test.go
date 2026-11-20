package livemode

import (
	"testing"
	"time"

	douyin "github.com/jwwsjlm/douyinLive/v2"
	proto "github.com/jwwsjlm/douyinlive-proto/generated/new_douyin"
	protobuf "google.golang.org/protobuf/proto"
)

func TestDecodeMessage(t *testing.T) {
	viewer := &proto.Webcast_Data_User{Nickname: "观众", Id: 123, IdStr: "456"}
	gift := &proto.Webcast_Data_GiftStruct{Name: "小心心", Combo: true}
	at := time.Now()
	testCases := []struct {
		name   string
		method string
		value  protobuf.Message
		kind   Kind
		text   string
		count  uint64
	}{
		{"chat", douyin.WebcastChatMessage, &proto.Webcast_Im_ChatMessage{User: viewer, Content: "你好"}, Chat, "你好", 1},
		{"gift", douyin.WebcastGiftMessage, &proto.Webcast_Im_GiftMessage{User: viewer, Gift: gift, RepeatEnd: 1, RepeatCount: 3}, Gift, "小心心", 3},
		{"gift combo in progress", douyin.WebcastGiftMessage, &proto.Webcast_Im_GiftMessage{User: viewer, Gift: gift}, "", "", 0},
		{"likes", douyin.WebcastLikeMessage, &proto.Webcast_Im_LikeMessage{User: viewer, Count: 12}, Like, "", 12},
		{"entry", douyin.WebcastMemberMessage, &proto.Webcast_Im_MemberMessage{User: viewer}, Enter, "", 1},
		{"follow", douyin.WebcastSocialMessage, &proto.Webcast_Im_SocialMessage{User: viewer, Action: 1}, Follow, "", 1},
		{"share", douyin.WebcastSocialMessage, &proto.Webcast_Im_SocialMessage{User: viewer, Action: 3}, "", "", 0},
		{"room control", douyin.WebcastControlMessage, &proto.Webcast_Im_ControlMessage{Action: 3}, "", "", 0},
	}
	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			payload, err := protobuf.Marshal(tc.value)
			if err != nil {
				t.Fatal(err)
			}
			event, ok := decodeMessage(&douyin.LiveMessage{
				Raw: &proto.Webcast_Im_Message{Method: tc.method, Payload: payload, MsgId: 42}, ReceivedAt: at,
			})
			if tc.kind == "" {
				if ok {
					t.Fatalf("unexpected event %+v", event)
				}
				return
			}
			if !ok || event.Kind != tc.kind || event.Text != tc.text || event.Count != tc.count ||
				event.Viewer != viewer.Nickname || event.viewerID != viewer.Id || event.key != "42" || !event.At.Equal(at) {
				t.Fatalf("unexpected event %+v, accepted %t", event, ok)
			}
		})
	}
}

func TestDecodeMessageRejectsInvalidPayload(t *testing.T) {
	for _, payload := range [][]byte{nil, {0xff}} {
		if _, ok := decodeMessage(&douyin.LiveMessage{
			Raw: &proto.Webcast_Im_Message{Method: douyin.WebcastMemberMessage, Payload: payload},
		}); ok {
			t.Fatalf("invalid payload was emitted as an interaction: %x", payload)
		}
	}
}
