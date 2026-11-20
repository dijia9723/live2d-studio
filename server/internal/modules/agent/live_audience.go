package agent

import "context"

type liveAudienceKey struct{}

func WithLiveAudience(ctx context.Context, instruction string) context.Context {
	return context.WithValue(ctx, liveAudienceKey{}, instruction)
}
