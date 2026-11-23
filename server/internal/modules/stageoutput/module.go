// Package stageoutput 将浏览器提交的舞台音视频发布为本机可播放的流。
package stageoutput

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/gin-gonic/gin"
	"server/internal/pkg"
)

const (
	rtspURL = "rtsp://127.0.0.1:8554/stage"
	rtmpURL = "rtmp://127.0.0.1:1935/stage"
	hlsURL  = "http://127.0.0.1:8888/stage/index.m3u8"
)

type Module struct {
	mu     sync.Mutex
	active *session
	closed bool
}

type session struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// Gin 1.11 在提交响应头后会拒绝 Hijack。握手头直接交给底层 HTTP
// writer，连接的 Hijack 仍经过 Gin，以更新框架的响应状态。
type upgradeWriter struct {
	http.ResponseWriter
	http.Hijacker
}

func (m *Module) Register(r *gin.RouterGroup) {
	r.GET("/stage-output", m.status)
	r.GET("/stage-output/stream", m.stream)
}

func (m *Module) Close() {
	m.mu.Lock()
	m.closed = true
	active := m.active
	m.mu.Unlock()
	if active != nil {
		active.cancel()
		<-active.done
	}
}

func (m *Module) status(c *gin.Context) {
	ffmpeg, media := executable("ffmpeg"), executable("mediamtx")
	missing := []string{}
	if ffmpeg == "" {
		missing = append(missing, "FFmpeg")
	}
	if media == "" {
		missing = append(missing, "MediaMTX")
	}
	m.mu.Lock()
	busy := m.active != nil
	m.mu.Unlock()
	pkg.OK(c, gin.H{"missing": missing, "busy": busy})
}

func (m *Module) stream(c *gin.Context) {
	origin := c.GetHeader("Origin")
	if origin != "http://"+c.Request.Host && origin != "https://"+c.Request.Host {
		pkg.Fail(c, http.StatusForbidden, "画布输出仅接受工作台同源连接")
		return
	}
	width, wErr := strconv.Atoi(c.Query("width"))
	height, hErr := strconv.Atoi(c.Query("height"))
	if wErr != nil || hErr != nil || !validSize(width) || !validSize(height) {
		pkg.Fail(c, http.StatusBadRequest, "画布输出尺寸无效")
		return
	}
	writer, ok := c.Writer.(interface{ Unwrap() http.ResponseWriter })
	if !ok {
		pkg.Fail(c, http.StatusInternalServerError, "当前 HTTP 服务不支持画布输出连接")
		return
	}
	conn, err := websocket.Accept(upgradeWriter{writer.Unwrap(), c.Writer}, c.Request, nil)
	if err != nil {
		slog.Debug("画布输出 WebSocket 升级失败", "error", err)
		return
	}
	defer conn.CloseNow()
	// 主动推送失败原因后再关闭连接，使浏览器能展示具体的恢复方式。
	report := func(kind, message string) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = wsjson.Write(ctx, conn, gin.H{"type": kind, "message": message})
	}
	ctx, cancel := context.WithCancel(c.Request.Context())
	run := &session{cancel: cancel, done: make(chan struct{})}
	m.mu.Lock()
	if m.active != nil || m.closed {
		m.mu.Unlock()
		cancel()
		report("error", "已有画布正在输出，请先停止另一个窗口的输出")
		return
	}
	m.active = run
	m.mu.Unlock()
	defer func() {
		cancel()
		m.mu.Lock()
		m.active = nil
		close(run.done)
		m.mu.Unlock()
	}()

	ffmpeg, media := executable("ffmpeg"), executable("mediamtx")
	if ffmpeg == "" || media == "" {
		report("error", "请先安装 FFmpeg 和 MediaMTX，并让 Studio 能找到它们")
		return
	}
	conn.SetReadLimit(4 << 20)
	// 等待浏览器完成权限选择并发送 WebM 的首个片段，再启动子进程。
	firstCtx, firstCancel := context.WithTimeout(ctx, 10*time.Second)
	kind, first, err := conn.Read(firstCtx)
	firstCancel()
	if err != nil {
		return
	}
	if kind != websocket.MessageBinary || len(first) < 4 || string(first[:4]) != "\x1a\x45\xdf\xa3" {
		report("error", "画布采集数据无效，请使用 Chrome 或 Edge 重新开始")
		return
	}
	publish(ctx, conn, ffmpeg, media, width, height, first, func() {
		readyCtx, readyCancel := context.WithTimeout(ctx, time.Second)
		defer readyCancel()
		_ = wsjson.Write(readyCtx, conn, gin.H{
			"type": "ready", "rtsp": rtspURL, "rtmp": rtmpURL, "hls": hlsURL,
		})
	}, func(err error) { report("error", err.Error()) })
}

func validSize(value int) bool {
	return value >= 16 && value <= 1920 && value%2 == 0
}
