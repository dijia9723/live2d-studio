package stageoutput

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/gin-gonic/gin"
)

func TestStreamRejectsCrossOrigin(t *testing.T) {
	router := gin.New()
	module := &Module{}
	module.Register(router.Group("/api"))
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/api/stage-output/stream?width=640&height=480", nil)
	request.Header.Set("Origin", "http://127.0.0.1:1234")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("got status %d, want 403", response.Code)
	}
}

func TestStreamRejectsInvalidMediaBeforeStartingEncoder(t *testing.T) {
	// An explicit path lets the handler reach input validation on machines without media tools.
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("STUDIO_FFMPEG_PATH", exe)
	t.Setenv("STUDIO_MEDIAMTX_PATH", exe)
	router := gin.New()
	module := &Module{}
	defer module.Close()
	module.Register(router.Group("/api"))
	server := httptest.NewServer(router)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/stage-output/stream?width=640&height=480", &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {server.URL}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if err := conn.Write(ctx, websocket.MessageBinary, []byte("bad media")); err != nil {
		t.Fatal(err)
	}
	var result map[string]string
	if err := wsjson.Read(ctx, conn, &result); err != nil {
		t.Fatal(err)
	}
	if result["type"] != "error" || !strings.Contains(result["message"], "采集数据无效") {
		t.Fatalf("unexpected response: %v", result)
	}
}
