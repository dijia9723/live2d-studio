package stageoutput

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

var addresses = []string{"127.0.0.1:8554", "127.0.0.1:1935", "127.0.0.1:8888"}

const mediaConfig = `logLevel: warn
rtspAddress: 127.0.0.1:8554
rtspTransports: [tcp]
rtmpAddress: 127.0.0.1:1935
hlsAddress: 127.0.0.1:8888
hlsAllowOrigins: ['http://127.0.0.1:8888']
webrtc: no
srt: no
moq: no
authInternalUsers:
  - user: encoder
    pass: %s
    ips: [127.0.0.1]
    permissions:
      - action: publish
        path: stage
  - user: any
    ips: [127.0.0.1]
    permissions:
      - action: read
        path: stage
paths:
  stage:
    source: publisher
`

func executable(name string) string {
	if path := os.Getenv("STUDIO_" + strings.ToUpper(name) + "_PATH"); path != "" {
		if resolved, err := exec.LookPath(path); err == nil {
			return resolved
		}
		return ""
	}
	if path, err := os.Executable(); err == nil {
		if resolved, err := exec.LookPath(filepath.Join(filepath.Dir(path), name)); err == nil {
			return resolved
		}
	}
	path, _ := exec.LookPath(name)
	return path
}

func publish(parent context.Context, conn *websocket.Conn, ffmpeg, mediamtx string, width, height int, first []byte, ready func(), failed func(error)) (failure error) {
	ctx, cancel := context.WithCancel(parent)
	var mediaDone, encoderDone, readDone <-chan struct{}
	var input io.WriteCloser
	var dir string
	defer func() {
		if failure != nil && parent.Err() == nil {
			failed(failure)
		}
		cancel()
		conn.CloseNow()
		if input != nil {
			input.Close()
		}
		for _, done := range []<-chan struct{}{readDone, encoderDone, mediaDone} {
			if done != nil {
				<-done
			}
		}
		if dir != "" {
			os.RemoveAll(dir)
		}
	}()
	// 先报告冲突端口，避免误把已有服务当成本次启动的 MediaMTX。
	for _, address := range addresses {
		listener, err := net.Listen("tcp4", address)
		if err != nil {
			return fmt.Errorf("画布输出端口 %s 被占用，请关闭使用该端口的程序后重试", address)
		}
		listener.Close()
	}
	var err error
	dir, err = os.MkdirTemp("", "live2d-stage-output-")
	if err != nil {
		return errors.New("无法创建直播临时目录")
	}
	key := uuid.NewString()
	config := filepath.Join(dir, "mediamtx.yml")
	if err := os.WriteFile(config, []byte(fmt.Sprintf(mediaConfig, key)), 0600); err != nil {
		return errors.New("无法写入直播配置")
	}
	media := command(ctx, mediamtx, config)
	// 不继承 MTX_* 配置，确保监听地址和仅本机发布的权限按本次配置生效。
	for _, value := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(value), "MTX_") {
			media.Env = append(media.Env, value)
		}
	}
	media.Dir = dir
	mediaDone, err = start(media)
	if err != nil {
		return errors.New("无法启动 MediaMTX")
	}
	if !waitForMedia(ctx, mediaDone) {
		return errors.New("MediaMTX 未能监听直播端口，请更新 MediaMTX 并检查端口")
	}

	destination, _ := url.Parse(rtspURL)
	destination.User = url.UserPassword("encoder", key)
	encoder := command(ctx, ffmpeg, encoderArgs(width, height, destination.String())...)
	input, err = encoder.StdinPipe()
	if err != nil {
		return errors.New("无法建立 FFmpeg 音视频输入")
	}
	progress := make(chan struct{}, 1)
	encoder.Stdout = &encoderProgress{changed: progress}
	encoderDone, err = start(encoder)
	if err != nil {
		return errors.New("无法启动 FFmpeg")
	}
	forwarded := make(chan struct{})
	readDone = forwarded
	go func() {
		forward(ctx, conn, input, first)
		close(forwarded)
	}()
	// FFmpeg 进度超时还能解除网络正常但编码输入堵住的连接。
	watchdog := time.NewTimer(20 * time.Second)
	defer watchdog.Stop()
	announced := false
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-readDone:
			return errors.New("画布采集已停止，或 FFmpeg 无法读取音视频")
		case <-mediaDone:
			return errors.New("MediaMTX 已退出，画布输出中断")
		case <-encoderDone:
			return errors.New("FFmpeg 编码失败，请确认安装了支持 libx264 和 AAC 的版本")
		case <-watchdog.C:
			return errors.New("长时间未收到有效的画布音视频，请重新开始共享")
		case <-progress:
			watchdog.Reset(20 * time.Second)
			if !announced {
				announced = true
				ready()
			}
		}
	}
}

func waitForMedia(ctx context.Context, done <-chan struct{}) bool {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	next := 0
	for next < len(addresses) {
		conn, err := (&net.Dialer{Timeout: 50 * time.Millisecond}).DialContext(ctx, "tcp", addresses[next])
		if err == nil {
			conn.Close()
			next++
			continue
		}
		select {
		case <-done:
			return false
		case <-ctx.Done():
			return false
		case <-ticker.C:
		}
	}
	return true
}

func encoderArgs(width, height int, destination string) []string {
	fit := fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1", width, height, width, height)
	return []string{
		"-hide_banner", "-loglevel", "error", "-nostdin", "-stats_period", "1", "-progress", "pipe:1",
		"-f", "webm", "-analyzeduration", "500000", "-probesize", "250000", "-i", "pipe:0",
		"-map", "0:v:0", "-map", "0:a:0", "-vf", fit, "-r", "30",
		"-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
		"-b:v", "3000k", "-maxrate", "4000k", "-bufsize", "2000k", "-g", "30",
		"-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
		"-f", "rtsp", "-rtsp_transport", "tcp", destination,
	}
}

type encoderProgress struct {
	changed chan struct{}
	tail    string
}

func (p *encoderProgress) Write(data []byte) (int, error) {
	const heartbeat = "progress=continue"
	output := p.tail + string(data)
	if strings.Contains(output, heartbeat) {
		select {
		case p.changed <- struct{}{}:
		default:
		}
	}
	p.tail = output[max(0, len(output)-len(heartbeat)+1):]
	return len(data), nil
}

func forward(ctx context.Context, conn *websocket.Conn, input io.Writer, chunk []byte) {
	for {
		if _, err := input.Write(chunk); err != nil {
			return
		}
		readCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		kind, data, err := conn.Read(readCtx)
		cancel()
		if err != nil {
			return
		}
		if kind != websocket.MessageBinary || len(data) == 0 {
			return
		}
		chunk = data
	}
}

func start(cmd *exec.Cmd) (<-chan struct{}, error) {
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	done := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(done)
	}()
	return done, nil
}
