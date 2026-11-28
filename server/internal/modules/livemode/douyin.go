// douyin.go 负责连接抖音直播间，解析弹幕、礼物、点赞、进场与关注事件，并维护连接状态。

package livemode

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strconv"
	"time"

	douyin "github.com/jwwsjlm/douyinLive/v2"
	proto "github.com/jwwsjlm/douyinlive-proto/generated/new_douyin"
	protobuf "google.golang.org/protobuf/proto"
)

// connection 描述对外的连接状态；offline 表示已确认主播下播，而不是普通的网络重试。
type connection struct {
	Phase   string `json:"phase"`
	Title   string `json:"title,omitempty"`
	Error   string `json:"error,omitempty"`
	offline bool
}

// 第三方抖音库会输出大量调试日志，这里丢弃，避免干扰应用自身的日志。
var listenerLog = slog.New(slog.NewTextHandler(io.Discard, nil))

// liveEndedAction 是抖音控制消息中表示直播结束的 action 值。
const liveEndedAction = 3

// douyinSource 持续监听直播间：断线或未开播时按配置的轮询周期重试，
// 直到会话被取消，保证一次 Start 就能覆盖整场直播中的网络波动。
func douyinSource(ctx context.Context, config Config, emit func(Event), update func(connection)) {
	for ctx.Err() == nil {
		update(connection{Phase: "checking"})
		err := listenDouyin(ctx, config.Room, emit, update)
		if ctx.Err() != nil {
			return
		}
		if err == nil || errors.Is(err, douyin.ErrLiveNotStarted) {
			update(connection{Phase: "waiting", offline: errors.Is(err, douyin.ErrLiveNotStarted)})
		} else {
			update(connection{Phase: "retrying", Error: "暂时无法连接抖音直播间，将按轮询设置重试"})
		}
		timer := time.NewTimer(time.Duration(config.PollSeconds) * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

// listenDouyin 建立一次直播间连接并阻塞到连接结束。
// 通过 context.AfterFunc 在会话取消时主动关闭客户端，确保底层 WebSocket 和协程不会泄漏。
func listenDouyin(ctx context.Context, room string, emit func(Event), update func(connection)) error {
	client, err := douyin.NewDouyinLiveWithSlog(room, listenerLog, "")
	if err != nil {
		return err
	}
	defer client.Dispose()
	stop := context.AfterFunc(ctx, client.Close)
	defer stop()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	online, err := client.IsLive()
	if err != nil {
		return err
	}
	if !online {
		return douyin.ErrLiveNotStarted
	}
	title := client.GetTitle()
	update(connection{Phase: "connecting", Title: title})
	subscription := client.SubscribeMessage(func(message *douyin.LiveMessage) {
		if ctx.Err() != nil || message == nil {
			return
		}
		messageTitle := message.Title
		if messageTitle == "" {
			messageTitle = title
		}
		if control, ok := message.Parsed.(*proto.Webcast_Im_ControlMessage); ok && control.GetAction() == liveEndedAction {
			update(connection{Phase: "waiting", Title: messageTitle, offline: true})
			return
		}
		update(connection{Phase: "live", Title: messageTitle})
		if event, ok := decodeMessage(message); ok {
			emit(event)
		}
	})
	defer client.Unsubscribe(subscription)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return client.Start()
}

// decodeMessage 把抖音原始消息转换为内部事件。
// 连击礼物只在连击结束时记一次，避免每颗礼物都触发回应；分享等非互动消息直接忽略。
func decodeMessage(message *douyin.LiveMessage) (Event, bool) {
	if message == nil {
		return Event{}, false
	}
	event := Event{At: message.ReceivedAt, Count: 1}
	if id := message.Raw.GetMsgId(); id != 0 {
		event.key = strconv.FormatUint(id, 10)
	}
	var viewer *proto.Webcast_Data_User
	switch item := decodePayload(message).(type) {
	case *proto.Webcast_Im_ChatMessage:
		if item.GetContent() == "" {
			return Event{}, false
		}
		event.Kind, event.Text, viewer = Chat, item.GetContent(), item.GetUser()
	case *proto.Webcast_Im_GiftMessage:
		gift := item.GetGift()
		if gift.GetCombo() && item.GetRepeatEnd() == 0 {
			return Event{}, false
		}
		event.Kind, event.Text, viewer = Gift, gift.GetName(), item.GetUser()
		if event.Text == "" {
			event.Text = "礼物"
		}
		event.Count = max(1, item.GetCount(), item.GetRepeatCount())
	case *proto.Webcast_Im_LikeMessage:
		event.Kind, event.Count, viewer = Like, max(1, item.GetCount()), item.GetUser()
	case *proto.Webcast_Im_MemberMessage:
		event.Kind, viewer = Enter, item.GetUser()
	case *proto.Webcast_Im_SocialMessage:
		if item.GetAction() != 1 {
			return Event{}, false
		}
		event.Kind, viewer = Follow, item.GetUser()
	default:
		return Event{}, false
	}
	event.Viewer = viewer.GetNickname()
	event.viewerID = viewer.GetId()
	if event.viewerID == 0 {
		event.viewerID, _ = strconv.ParseUint(viewer.GetIdStr(), 10, 64)
	}
	return event, true
}

// decodePayload 取出消息载荷。douyinLive 部分版本不会填充 Parsed 字段，
// 因此这里按 Method 回退到原始 Protobuf 解析。
func decodePayload(message *douyin.LiveMessage) protobuf.Message {
	if message.Parsed != nil {
		return message.Parsed
	}
	// douyinLive v2.0.25 会把互动消息留在原始 Protobuf 信封中，需要手动解码。
	var decoded protobuf.Message
	switch message.GetMethod() {
	case douyin.WebcastChatMessage:
		decoded = &proto.Webcast_Im_ChatMessage{}
	case douyin.WebcastGiftMessage:
		decoded = &proto.Webcast_Im_GiftMessage{}
	case douyin.WebcastLikeMessage:
		decoded = &proto.Webcast_Im_LikeMessage{}
	case douyin.WebcastMemberMessage:
		decoded = &proto.Webcast_Im_MemberMessage{}
	case douyin.WebcastSocialMessage:
		decoded = &proto.Webcast_Im_SocialMessage{}
	default:
		return nil
	}
	payload := message.GetPayload()
	if len(payload) == 0 || protobuf.Unmarshal(payload, decoded) != nil {
		return nil
	}
	return decoded
}
