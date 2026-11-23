// host_worker.go 是插件子进程侧入口：在 goja 沙箱中执行 JavaScript 并通过 JSON 行协议通信。
package piplugins

import (
	"bufio"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"time"

	"github.com/dop251/goja"
)

//go:embed host_worker.js
var hostWorkerPrelude string

const (
	workerLineLimit = 2 << 20
	workerDataLimit = 32 << 10
)

type hostRequest struct {
	Operation string          `json:"operation"`
	ID        string          `json:"id,omitempty"`
	From      string          `json:"from,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	Load      *hostWorkerLoad `json:"load,omitempty"`
}

type hostWorkerLoad struct {
	Source   string                `json:"source"`
	Main     string                `json:"main"`
	Modules  map[string]string     `json:"modules,omitempty"`
	Spec     hostSpec              `json:"spec"`
	Manifest Manifest              `json:"manifest"`
	Settings json.RawMessage       `json:"settings"`
	Storage  json.RawMessage       `json:"storage"`
	Models   []HostCompletionModel `json:"models,omitempty"`
}

type hostEvent struct {
	Type  string          `json:"type"`
	Text  string          `json:"text,omitempty"`
	ID    string          `json:"id,omitempty"`
	Title string          `json:"title,omitempty"`
	Topic string          `json:"topic,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
}

type hostResponse struct {
	Async      bool                   `json:"async,omitempty"`
	Error      string                 `json:"error,omitempty"`
	Result     json.RawMessage        `json:"result,omitempty"`
	Events     []hostEvent            `json:"events"`
	Completion *hostCompletionRequest `json:"completion,omitempty"`
}

// workerRuntime 封装 goja 运行时与预置的调度函数，所有插件调用都经由 prepare/settle/tick 进入沙箱。
type workerRuntime struct {
	vm              *goja.Runtime
	prepare         goja.Callable
	settle          goja.Callable
	tick            goja.Callable
	drain           goja.Callable
	complete        func(string) string
	inTimer         bool
	modelPermission bool
}

// newWorkerRuntime 装载预置桥接脚本并取得内部调度函数，限制调用栈深度以防深递归耗尽内存。
func newWorkerRuntime() (*workerRuntime, error) {
	vm := goja.New()
	vm.SetMaxCallStackSize(1024)
	if _, err := vm.RunString(hostWorkerPrelude); err != nil {
		return nil, err
	}
	prepare, a := goja.AssertFunction(vm.Get("__piPrepare"))
	settle, b := goja.AssertFunction(vm.Get("__piSettle"))
	tick, c := goja.AssertFunction(vm.Get("__piTick"))
	drain, d := goja.AssertFunction(vm.Get("__piDrain"))
	if !a || !b || !c || !d {
		return nil, errors.New("无法装载插件运行接口")
	}
	return &workerRuntime{vm: vm, prepare: prepare, settle: settle, tick: tick, drain: drain}, nil
}

// budget 用中断机制为单次执行设定时间上限，返回的函数负责停止计时并清除中断标记。
func (w *workerRuntime) budget(duration time.Duration) func() {
	finished := make(chan struct{})
	timer := time.AfterFunc(duration, func() {
		w.vm.Interrupt("plugin execution budget exceeded")
		close(finished)
	})
	return func() {
		if !timer.Stop() {
			<-finished
		}
		w.vm.ClearInterrupt()
	}
}

// run 在沙箱内执行一次调用：先处理 load 注入入口源码，再等待返回的 Promise 在预算内落定。
// 参数与结果都走 JSON，避免向 JS 暴露任意 Go 对象。
func (w *workerRuntime) run(request hostRequest) hostResponse {
	duration := 3500 * time.Millisecond
	if w.modelPermission && completionOperation(request.Operation) {
		duration = 10500 * time.Millisecond
	}
	unbudget := w.budget(duration)
	defer unbudget()
	fail := func(message string) hostResponse {
		return hostResponse{Error: message, Events: w.events()}
	}
	if request.Operation == "load" {
		if request.Load == nil || len(request.Load.Source) > 768<<10 {
			return fail("插件入口无效或超出大小限制")
		}
		for _, permission := range request.Load.Spec.Permissions {
			if permission == "agent.complete" {
				w.modelPermission = true
			}
		}
		source := request.Load.Source
		request.Load.Source = ""
		configuration, err := json.Marshal(request.Load)
		if err != nil {
			return fail("插件配置无效")
		}
		if _, err := w.prepare(goja.Undefined(), w.vm.ToValue(string(configuration)), w.vm.ToValue(w.complete)); err != nil {
			return fail("插件配置初始化失败")
		}
		if _, err := w.vm.RunScript("plugin-main.js", source); err != nil {
			return fail("插件入口执行失败。此宿主支持不依赖 Node.js 模块的 CommonJS 入口。")
		}
	}
	request.Load = nil
	raw, err := json.Marshal(request)
	if err != nil {
		return fail("插件调用参数无效")
	}
	value, err := w.settle(goja.Undefined(), w.vm.ToValue(request.Operation), w.vm.ToValue(string(raw)))
	if err != nil {
		return fail("插件执行失败或超时")
	}
	promise, ok := value.Export().(*goja.Promise)
	if !ok {
		return fail("插件没有返回有效结果")
	}
	deadline := time.Now().Add(2200 * time.Millisecond)
	for promise.State() == goja.PromiseStatePending && time.Now().Before(deadline) {
		time.Sleep(15 * time.Millisecond)
		if err := w.runTimer(); err != nil {
			return fail("插件执行失败或超时")
		}
	}
	if promise.State() != goja.PromiseStateFulfilled {
		return fail("插件操作被拒绝或超时")
	}
	result := json.RawMessage(promise.Result().String())
	if len(result) > workerDataLimit || !json.Valid(result) {
		return fail("插件结果超出限制或格式无效")
	}
	return hostResponse{Result: result, Events: w.events()}
}

// events 取出并清空沙箱积压的事件，超出大小或格式错误时整体丢弃以免污染后续调用。
func (w *workerRuntime) events() []hostEvent {
	raw, err := w.drain(goja.Undefined())
	if err != nil {
		return nil
	}
	text := raw.String()
	if len(text) > 256<<10 {
		return nil
	}
	var events []hostEvent
	if json.Unmarshal([]byte(text), &events) != nil {
		return nil
	}
	return events
}

// timerEvents 驱动插件注册的定时器并回收其产生的事件，使常驻服务可以主动推送。
func (w *workerRuntime) timerEvents() []hostEvent {
	unbudget := w.budget(3500 * time.Millisecond)
	defer unbudget()
	if err := w.runTimer(); err != nil {
		return nil
	}
	return w.events()
}

// runTimer 标记当前处于定时器回调内，补全等主动请求在该阶段会被拒绝。
func (w *workerRuntime) runTimer() error {
	w.inTimer = true
	defer func() { w.inTimer = false }()
	_, err := w.tick(goja.Undefined())
	return err
}

// RunPluginWorker 是插件子进程的 JSON-only 入口。它刻意不初始化 Studio、不继承模型配置，
// 也不向 JS 暴露操作系统与网络接口，插件只能通过消息通道请求宿主能力。
func RunPluginWorker(input io.Reader, output io.Writer) int {
	runtime, err := newWorkerRuntime()
	if err != nil {
		return 1
	}
	requests := make(chan hostRequest)
	completions := make(chan hostRequest)
	done := make(chan struct{})
	defer close(done)
	go func() {
		defer close(requests)
		defer close(completions)
		scanner := bufio.NewScanner(input)
		scanner.Buffer(make([]byte, 4096), workerLineLimit)
		for scanner.Scan() {
			var request hostRequest
			if json.Unmarshal(scanner.Bytes(), &request) != nil {
				return
			}
			sink := requests
			if request.Operation == "completion" {
				sink = completions
			}
			select {
			case sink <- request:
			case <-done:
				return
			}
		}
	}()
	encoder := json.NewEncoder(output)
	var operation string
	var serial uint64
	runtime.complete = func(raw string) string {
		failure := `{"error":"模型补全失败或已超时"}`
		if runtime.inTimer || !completionOperation(operation) || len(raw) > workerDataLimit || !json.Valid([]byte(raw)) {
			return `{"error":"当前插件事件不可发起模型补全"}`
		}
		serial++
		id := strconv.FormatUint(serial, 10)
		if encoder.Encode(hostResponse{
			Async: true, Completion: &hostCompletionRequest{ID: id, Options: json.RawMessage(raw)},
		}) != nil {
			return failure
		}
		timer := time.NewTimer(9 * time.Second)
		defer timer.Stop()
		for {
			select {
			case record, ok := <-completions:
				if !ok {
					return failure
				}
				if record.ID == id && len(record.Payload) <= workerDataLimit && json.Valid(record.Payload) {
					return string(record.Payload)
				}
			case <-timer.C:
				return failure
			}
		}
	}
	ticker := time.NewTicker(125 * time.Millisecond)
	defer ticker.Stop()
	loaded := false
	for {
		select {
		case request, ok := <-requests:
			if !ok {
				return 0
			}
			if loaded == (request.Operation == "load") {
				return 1
			}
			operation = request.Operation
			response := runtime.run(request)
			operation = ""
			if len(response.Events) == 0 {
				response.Events = []hostEvent{}
			}
			if err := encoder.Encode(response); err != nil {
				return 1
			}
			if request.Operation == "shutdown" || (!loaded && response.Error != "") {
				return 0
			}
			loaded = true
		case <-ticker.C:
			if loaded {
				events := runtime.timerEvents()
				if len(events) > 0 && encoder.Encode(hostResponse{Async: true, Events: events}) != nil {
					return 1
				}
			}
		}
	}
}
