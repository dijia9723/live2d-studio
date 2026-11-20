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

//go:embed synthesize.py
var worker string

var ErrUnavailable = errors.New("请先安装本地 TTS 推理环境和所选模型")
var ErrBusy = errors.New("本地 TTS 正在处理另一条请求，请稍后重试")

// Runtime runs CPU inference in an isolated Python process and limits it to one request at a time.
type Runtime struct {
	dir  string
	slot chan struct{}
}

type Catalog struct {
	RuntimeInstalled bool    `json:"runtime_installed"`
	MaxTextLength    int     `json:"max_text_length"`
	Models           []model `json:"models"`
}

func New(dir string) *Runtime {
	return &Runtime{dir: dir, slot: make(chan struct{}, 1)}
}

func (r *Runtime) Catalog() Catalog {
	c := Catalog{RuntimeInstalled: fileExists(r.python()), MaxTextLength: MaxTextLength, Models: make([]model, 0, len(models))}
	for _, m := range models {
		m.Installed = m.installed(filepath.Join(r.dir, m.dir))
		c.Models = append(c.Models, m)
	}
	return c
}

func (r *Runtime) python() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(r.dir, ".venv", "Scripts", "python.exe")
	}
	return filepath.Join(r.dir, ".venv", "bin", "python")
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0
}

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
	select {
	case r.slot <- struct{}{}:
		defer func() { <-r.slot }()
	default:
		return nil, ErrBusy
	}
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
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	// Keep model paths relative to support project directories containing non-ASCII names.
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
