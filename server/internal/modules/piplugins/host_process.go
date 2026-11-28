// host_process.go 负责启动独立的插件子进程，并维护 JSON 行协议的消息通道。
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

// hostedWorker 代表一个插件子进程：gate 保证同一时刻只有一个同步调用，
// active 记录当前调用的截止时间，用于限制该调用内可发起的补全与工作区请求。
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

// spawnHostWorker 以自身可执行文件加 -pi-plugin-host 参数拉起隔离子进程。
// 子进程只共享 stdin/stdout 管道，不继承宿主环境变量与数据库连接。
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

// call 发送一次请求并等待回复；超时后直接终止进程，避免半读写的管道状态被继续使用。
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

// completionOperation 标记可触发模型补全的调用类型，只有这些调用会开启较长的执行预算。
func completionOperation(operation string) bool {
	return operation == "command" || operation == "tool" || operation == "panel"
}

func (w *hostedWorker) write(request hostRequest) error {
	w.wireMu.Lock()
	defer w.wireMu.Unlock()
	return json.NewEncoder(w.input).Encode(request)
}

// claimCompletion 限定单次调用内最多两次补全，返回调用自身的截止上下文。
func (w *hostedWorker) claimCompletion() (context.Context, bool) {
	w.activeMu.Lock()
	defer w.activeMu.Unlock()
	if w.active == nil || w.active.Err() != nil || w.completions >= 2 {
		return nil, false
	}
	w.completions++
	return w.active, true
}

// claimWorkspace 限定单次调用内的工作区访问次数，防止插件反复读取项目数据。
func (w *hostedWorker) claimWorkspace() (context.Context, bool) {
	w.activeMu.Lock()
	defer w.activeMu.Unlock()
	if w.active == nil || w.active.Err() != nil || w.workspaceCalls >= 20 {
		return nil, false
	}
	w.workspaceCalls++
	return w.active, true
}

// terminate 幂等关闭管道并杀死子进程；sync.Once 保证多路清理不会重复执行。
func (w *hostedWorker) terminate() {
	w.stop.Do(func() {
		_ = w.input.Close()
		_ = w.cmd.Process.Kill()
	})
}
