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

type connection struct {
	Phase   string `json:"phase"`
	Title   string `json:"title,omitempty"`
	Error   string `json:"error,omitempty"`
	offline bool
}

var listenerLog = slog.New(slog.NewTextHandler(io.Discard, nil))

const liveEndedAction = 3

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

func decodePayload(message *douyin.LiveMessage) protobuf.Message {
	if message.Parsed != nil {
		return message.Parsed
	}
	// douyinLive v2.0.25 leaves interaction messages in the raw Protobuf envelope.
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
