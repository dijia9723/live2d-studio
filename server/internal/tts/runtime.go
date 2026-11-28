// runtime.go 负责调用本地 Python 推理进程完成离线 TTS 合成，并控制并发与超时。

package tts

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// worker 是内嵌的 Python 合成脚本，随程序一起分发，避免依赖外部文件。
//
//go:embed synthesize.py
var worker string

// ErrUnavailable 表示本地推理环境或所选模型尚未安装。
var ErrUnavailable = errors.New("请先安装本地 TTS 推理环境和所选模型")

// ErrBusy 表示当前已有一条合成任务在运行，CPU 推理不支持并行叠加。
var ErrBusy = errors.New("本地 TTS 正在处理另一条请求，请稍后重试")

// Runtime 在隔离的 Python 子进程中执行 CPU 推理，并通过信号量把并发限制为一次一条。
type Runtime struct {
	dir  string
	slot chan struct{}
}

// Catalog 描述本地 TTS 环境与模型安装情况。
type Catalog struct {
	RuntimeInstalled bool    `json:"runtime_installed"`
	MaxTextLength    int     `json:"max_text_length"`
	Models           []model `json:"models"`
}

// New 创建 TTS 运行时；slot 容量为 1，确保同一时刻只有一个子进程占用内存和 CPU。
func New(dir string) *Runtime {
	return &Runtime{dir: dir, slot: make(chan struct{}, 1)}
}

// Catalog 扫描本地环境与各模型的必需文件，返回可安装/已安装状态。
func (r *Runtime) Catalog() Catalog {
	c := Catalog{RuntimeInstalled: fileExists(r.python()), MaxTextLength: MaxTextLength, Models: make([]model, 0, len(models))}
	for _, m := range models {
		m.Installed = m.installed(filepath.Join(r.dir, m.dir))
		c.Models = append(c.Models, m)
	}
	return c
}

// python 返回虚拟环境中的解释器路径；Windows 与类 Unix 的目录结构不同。
func (r *Runtime) python() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(r.dir, ".venv", "Scripts", "python.exe")
	}
	return filepath.Join(r.dir, ".venv", "bin", "python")
}

// fileExists 要求目标是非空普通文件，防止把目录或空占位文件当成已安装。
func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0
}

// installed 检查模型目录下是否具备推理所需的全部文件。
func (m model) installed(dir string) bool {
	files := []string{m.weights, "tokens.txt"}
	if m.kokoro {
		files = append(files, "voices.bin", "lexicon-us-en.txt", "lexicon-zh.txt", "espeak-ng-data/phontab")
	} else {
		files = append(files, "lexicon.txt")
	}
	for _, name := range append(files, m.rules...) {
		if !fileExists(filepath.Join(dir, name)) {
			return false
		}
	}
	return true
}

// Synthesize 把文本合成为 WAV 音频。
// 每次请求都启动独立的 Python 进程，模型崩溃或超时不会污染主进程；
// 通过在项目目录内以相对路径运行，兼容包含非 ASCII 字符的路径。
func (r *Runtime) Synthesize(ctx context.Context, text string, options Options) ([]byte, error) {
	m, err := options.resolve()
	if err != nil {
		return nil, err
	}
	python, err := filepath.Abs(r.python())
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(r.dir, m.dir)
	if !fileExists(python) || !m.installed(dir) {
		return nil, ErrUnavailable
	}
	// 用非阻塞方式争抢唯一槽位，忙时立即返回错误而不是排队占用请求。
	select {
	case r.slot <- struct{}{}:
		defer func() { <-r.slot }()
	default:
		return nil, ErrBusy
	}
	// 临时文件放在系统临时目录并在结束时删除，避免合成中断留下垃圾文件。
	temp, err := os.CreateTemp("", "studio-tts-*.wav")
	if err != nil {
		return nil, err
	}
	defer os.Remove(temp.Name())
	if err = temp.Close(); err != nil {
		return nil, err
	}
	payload, err := json.Marshal(struct {
		Options
		Text    string `json:"text"`
		Output  string `json:"output"`
		Weights string `json:"weights"`
		Rules   string `json:"rules"`
		Kokoro  bool   `json:"kokoro"`
	}{options, text, temp.Name(), m.weights, strings.Join(m.rules, ","), m.kokoro})
	if err != nil {
		return nil, err
	}
	// 超时后 CommandContext 会结束子进程，防止模型卡死导致请求永久挂起。
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	// 保持模型路径相对于工作目录，以支持包含非 ASCII 字符的项目路径。
	cmd := exec.CommandContext(ctx, python, "-I", "-c", worker)
	cmd.Dir = dir
	cmd.Stdin = bytes.NewReader(payload)
	hideWindow(cmd)
	if err = cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("TTS 推理失败: %w", err)
	}
	file, err := os.Open(temp.Name())
	if err != nil {
		return nil, err
	}
	defer file.Close()
	// 限制读取上限，并校验 RIFF/WAVE 头，避免把异常的大文件或非音频内容返回给调用方。
	const maxAudio = 30 << 20
	wav, err := io.ReadAll(io.LimitReader(file, maxAudio+1))
	if err != nil {
		return nil, err
	}
	if len(wav) <= 44 || len(wav) > maxAudio || string(wav[:4]) != "RIFF" || string(wav[8:12]) != "WAVE" {
		return nil, errors.New("本地 TTS 返回了无效 WAV 音频")
	}
	return wav, nil
}
