package piplugins

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"sync"
	"time"
)

type hostedWorker struct {
	installation   Installation
	cmd            *exec.Cmd
	input          io.WriteCloser
	replies        chan hostResponse
	done           chan struct{}
	gate           chan struct{}
	stop           sync.Once
	wireMu         sync.Mutex
	activeMu       sync.Mutex
	active         context.Context
	completions    int
	workspaceCalls int
}

func spawnHostWorker(executable string, installation Installation, async func(*hostedWorker, hostResponse)) (*hostedWorker, error) {
	cmd := exec.Command(executable, "-pi-plugin-host")
	cmd.Env = []string{"GOMEMLIMIT=96MiB", "GOMAXPROCS=2"}
	setupHostedProcess(cmd)
	input, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		input.Close()
		output.Close()
		return nil, err
	}
	free, err := limitHostedProcess(cmd)
	if err != nil {
		input.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, err
	}
	worker := &hostedWorker{installation: installation, cmd: cmd, input: input,
		replies: make(chan hostResponse, 1), done: make(chan struct{}), gate: make(chan struct{}, 1),
	}
	go func() {
		defer close(worker.done)
		defer free()
		defer cmd.Wait()
		defer worker.terminate()
		reader := bufio.NewScanner(output)
		reader.Buffer(make([]byte, 4096), workerLineLimit)
		for reader.Scan() {
			var reply hostResponse
			if json.Unmarshal(reader.Bytes(), &reply) != nil {
				return
			}
			if reply.Async {
				async(worker, reply)
				continue
			}
			select {
			case worker.replies <- reply:
			default:
				return
			}
		}
	}()
	return worker, nil
}

func (w *hostedWorker) call(ctx context.Context, request hostRequest) (hostResponse, error) {
	timeout := 5 * time.Second
	if completionOperation(request.Operation) {
		timeout = 12 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	select {
	case <-w.done:
		return hostResponse{}, errors.New("插件进程已退出")
	case w.gate <- struct{}{}:
		defer func() { <-w.gate }()
	case <-ctx.Done():
		return hostResponse{}, ctx.Err()
	}
	if completionOperation(request.Operation) {
		w.activeMu.Lock()
		w.active, w.completions = ctx, 0
		w.workspaceCalls = 0
		w.activeMu.Unlock()
		defer func() {
			w.activeMu.Lock()
			defer w.activeMu.Unlock()
			w.active = nil
		}()
	}
	sent := make(chan error, 1)
	go func() { sent <- w.write(request) }()
	select {
	case err := <-sent:
		if err != nil {
			return hostResponse{}, errors.New("插件进程不可用")
		}
	case <-ctx.Done():
		w.terminate()
		return hostResponse{}, ctx.Err()
	}
	select {
	case reply := <-w.replies:
		return reply, nil
	case <-w.done:
		// Shutdown closes the worker after sending its final response.
		select {
		case reply := <-w.replies:
			return reply, nil
		default:
			return hostResponse{}, errors.New("插件进程已退出")
		}
	case <-ctx.Done():
		w.terminate()
		return hostResponse{}, ctx.Err()
	}
}

func completionOperation(operation string) bool {
	return operation == "command" || operation == "tool" || operation == "panel"
}

func (w *hostedWorker) write(request hostRequest) error {
	w.wireMu.Lock()
	defer w.wireMu.Unlock()
	return json.NewEncoder(w.input).Encode(request)
}

func (w *hostedWorker) claimCompletion() (context.Context, bool) {
	w.activeMu.Lock()
	defer w.activeMu.Unlock()
	if w.active == nil || w.active.Err() != nil || w.completions >= 2 {
		return nil, false
	}
	w.completions++
	return w.active, true
}

func (w *hostedWorker) claimWorkspace() (context.Context, bool) {
	w.activeMu.Lock()
	defer w.activeMu.Unlock()
	if w.active == nil || w.active.Err() != nil || w.workspaceCalls >= 20 {
		return nil, false
	}
	w.workspaceCalls++
	return w.active, true
}

func (w *hostedWorker) terminate() {
	w.stop.Do(func() {
		_ = w.input.Close()
		_ = w.cmd.Process.Kill()
	})
}
