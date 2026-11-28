// browser_debug.go 负责启动隔离的无头浏览器，并通过 CDP 执行导航、可访问性检查与截图。
package coding

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

const browserDebugIdle = 5 * time.Minute

var (
	errBrowserBusy  = errors.New("已有浏览器调试会话")
	errBrowserGone  = errors.New("浏览器调试会话不存在或已结束")
	browserTargetID = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)
)

// BrowserDebugService 管理一个按需启动、使用临时配置目录的独立浏览器实例。
type BrowserDebugService struct {
	mu      sync.Mutex
	active  *browserDebugSession
	opening bool
	closed  bool
}

// NewBrowserDebugService 创建一个空闲的浏览器调试服务。
func NewBrowserDebugService() *BrowserDebugService { return &BrowserDebugService{} }

type browserDebugSession struct {
	id      string
	dir     string
	process *exec.Cmd
	done    chan struct{}
	client  *websocket.Conn
	idle    *time.Timer

	calls chan struct{}
	next  int
}

func browserDebugExecutable() string {
	var choices []string
	switch runtime.GOOS {
	case "windows":
		for _, key := range []string{"ProgramW6432", "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"} {
			if base := os.Getenv(key); filepath.IsAbs(base) {
				choices = append(choices,
					filepath.Join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
					filepath.Join(base, "Google", "Chrome", "Application", "chrome.exe"),
					filepath.Join(base, "Chromium", "Application", "chrome.exe"),
				)
			}
		}
		choices = append(choices, "msedge.exe", "chrome.exe", "chromium.exe")
	case "darwin":
		choices = append(choices,
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		)
	default:
		choices = append(choices, "microsoft-edge", "google-chrome", "chromium", "chromium-browser")
	}
	for _, choice := range choices {
		if found, err := exec.LookPath(choice); err == nil && filepath.IsAbs(found) {
			return found
		}
	}
	return ""
}

func (s *BrowserDebugService) start(ctx context.Context) (*browserDebugSession, error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, errBrowserGone
	}
	if s.opening || s.active != nil {
		s.mu.Unlock()
		return nil, errBrowserBusy
	}
	s.opening = true
	s.mu.Unlock()
	// 启动过程不持锁，仅用 opening 标记阻止并发启动；完成后重新加锁确认服务未被关闭。
	session, err := openDebugBrowser(ctx)
	s.mu.Lock()
	s.opening = false
	if err != nil || s.closed {
		s.mu.Unlock()
		if session != nil {
			session.stop()
		}
		if err != nil {
			return nil, err
		}
		return nil, errBrowserGone
	}
	s.active = session
	session.idle = time.AfterFunc(browserDebugIdle, func() { _ = s.stop(session.id) })
	s.mu.Unlock()
	go func() {
		<-session.done
		_ = s.stop(session.id)
	}()
	return session, nil
}

func (s *BrowserDebugService) session(id string) (*browserDebugSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active == nil || s.active.id != id {
		return nil, errBrowserGone
	}
	s.active.idle.Reset(browserDebugIdle)
	return s.active, nil
}

func (s *BrowserDebugService) stop(id string) error {
	s.mu.Lock()
	if s.active == nil || s.active.id != id {
		s.mu.Unlock()
		return errBrowserGone
	}
	session := s.active
	s.active = nil
	session.idle.Stop()
	s.mu.Unlock()
	session.stop()
	return nil
}

// Close 关闭调试浏览器、清理临时配置并停止服务。
func (s *BrowserDebugService) Close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.closed = true
	session := s.active
	s.mu.Unlock()
	if session != nil {
		_ = s.stop(session.id)
	}
}

func openDebugBrowser(ctx context.Context) (*browserDebugSession, error) {
	browser := browserDebugExecutable()
	if browser == "" {
		return nil, errors.New("请先安装 Edge、Chrome 或 Chromium")
	}
	dir, err := os.MkdirTemp("", "studio-browser-")
	if err != nil {
		return nil, errors.New("无法创建浏览器临时配置")
	}
	args := []string{
		"--headless=new", "--user-data-dir=" + dir, "--remote-debugging-port=0",
		"--remote-debugging-address=127.0.0.1", "--window-size=1280,800",
		"--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync",
		"--disable-background-networking", "--disable-component-update", "--disable-breakpad",
		"--disable-default-apps", "--auth-schemes=basic,digest", "--no-pings", "about:blank",
	}
	cmd := exec.Command(browser, args...)
	// 使用过滤后的环境，避免把 Studio 的配置和密钥带进被调试的浏览器。
	cmd.Env = terminalEnvironment()
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		_ = os.RemoveAll(dir)
		return nil, errors.New("无法启动独立浏览器")
	}
	p := &browserDebugSession{id: uuid.NewString(), dir: dir, process: cmd, done: make(chan struct{}), calls: make(chan struct{}, 1)}
	// 进程退出时关闭 done，服务据此回收会话并清理临时目录。
	go func() {
		_ = cmd.Wait()
		close(p.done)
	}()
	startup, cancel := context.WithTimeout(ctx, 9*time.Second)
	defer cancel()
	socket, err := connectDebugBrowser(startup, p)
	if err != nil {
		p.stop()
		return nil, err
	}
	p.client = socket
	download := map[string]any{"behavior": "deny"}
	if err := p.call(startup, "Browser.setDownloadBehavior", download, nil); err != nil {
		if err := p.call(startup, "Page.setDownloadBehavior", download, nil); err != nil {
			p.stop()
			return nil, errors.New("浏览器无法启用调试下载限制")
		}
	}
	if err := p.call(startup, "Page.enable", nil, nil); err != nil {
		p.stop()
		return nil, err
	}
	return p, nil
}

func connectDebugBrowser(ctx context.Context, session *browserDebugSession) (*websocket.Conn, error) {
	transport := &http.Transport{
		DialContext:            (&net.Dialer{Timeout: 500 * time.Millisecond}).DialContext,
		DisableKeepAlives:      true,
		MaxResponseHeaderBytes: 64 << 10,
	}
	rejectRedirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	client := &http.Client{Timeout: 700 * time.Millisecond, Transport: transport, CheckRedirect: rejectRedirect}
	webSockets := &http.Client{Transport: transport, CheckRedirect: rejectRedirect}
	timer := time.NewTicker(100 * time.Millisecond)
	defer timer.Stop()
	for {
		targets, err := os.ReadFile(filepath.Join(session.dir, "DevToolsActivePort"))
		if err == nil && len(targets) < 512 {
			port, _, _ := strings.Cut(string(targets), "\n")
			if n, err := strconv.ParseUint(strings.TrimSpace(port), 10, 16); err == nil && n != 0 {
				host := "127.0.0.1:" + strconv.FormatUint(n, 10)
				if id := browserPageTarget(ctx, client, host); id != "" {
					ws, _, err := websocket.Dial(ctx, "ws://"+host+"/devtools/page/"+id, &websocket.DialOptions{HTTPClient: webSockets})
					if err == nil {
						ws.SetReadLimit(8 << 20)
						return ws, nil
					}
				}
			}
		}
		select {
		case <-ctx.Done():
			return nil, errors.New("浏览器调试端口未就绪")
		case <-session.done:
			return nil, errors.New("独立浏览器启动时退出")
		case <-timer.C:
		}
	}
}

func browserPageTarget(ctx context.Context, client *http.Client, host string) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+host+"/json/list", nil)
	if err != nil {
		return ""
	}
	response, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return ""
	}
	var tabs []struct {
		ID   string `json:"id"`
		Type string `json:"type"`
		URL  string `json:"url"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 128<<10)).Decode(&tabs) != nil {
		return ""
	}
	for _, tab := range tabs {
		if tab.Type == "page" && tab.URL == "about:blank" && browserTargetID.MatchString(tab.ID) {
			return tab.ID
		}
	}
	return ""
}

func (p *browserDebugSession) stop() {
	if p.client != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
		_ = p.call(ctx, "Browser.close", nil, nil)
		cancel()
		_ = p.client.CloseNow()
	}
	select {
	case <-p.done:
	case <-time.After(800 * time.Millisecond):
		_ = p.process.Process.Kill()
		select {
		case <-p.done:
		case <-time.After(500 * time.Millisecond):
		}
	}
	// 调用线程被阻塞过久时用进程退出作为兜底信号；随后删除临时配置目录，失败时短暂重试。
	for range 5 {
		if os.RemoveAll(p.dir) == nil {
			return
		}
		time.Sleep(80 * time.Millisecond)
	}
}

// call 发送一条 CDP 请求并等待同 ID 的响应；单槽信号量保证同一连接上的请求串行，避免响应错配。
func (p *browserDebugSession) call(ctx context.Context, method string, parameters, result any) error {
	select {
	case p.calls <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-p.calls }()
	p.next++
	request := struct {
		ID     int    `json:"id"`
		Method string `json:"method"`
		Params any    `json:"params,omitempty"`
	}{p.next, method, parameters}
	data, err := json.Marshal(request)
	if err != nil {
		return err
	}
	if err := p.client.Write(ctx, websocket.MessageText, data); err != nil {
		return errors.New("浏览器调试连接已关闭")
	}
	for {
		_, data, err := p.client.Read(ctx)
		if err != nil {
			return errors.New("浏览器调试连接已关闭")
		}
		var reply struct {
			ID     int             `json:"id"`
			Error  json.RawMessage `json:"error"`
			Result json.RawMessage `json:"result"`
		}
		if err := json.Unmarshal(data, &reply); err != nil || reply.ID != request.ID {
			continue
		}
		if reply.Error != nil {
			return errors.New("浏览器不支持此调试操作")
		}
		if result == nil {
			return nil
		}
		if err := json.Unmarshal(reply.Result, result); err != nil {
			return errors.New("浏览器返回了无效的调试数据")
		}
		return nil
	}
}

func normalizeDebugPage(raw string) (string, error) {
	target, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || target == nil || len(raw) > 4096 || target.Hostname() == "" || target.User != nil ||
		(target.Scheme != "http" && target.Scheme != "https") {
		return "", errors.New("请输入不含登录凭据的 HTTP 或 HTTPS 地址")
	}
	return target.String(), nil
}

func (p *browserDebugSession) navigate(ctx context.Context, target string) error {
	var result struct {
		ErrorText  string `json:"errorText"`
		IsDownload bool   `json:"isDownload"`
	}
	if err := p.call(ctx, "Page.navigate", map[string]any{"url": target}, &result); err != nil {
		return err
	}
	if result.IsDownload {
		return errors.New("调试浏览器不下载文件")
	}
	if result.ErrorText != "" {
		return fmt.Errorf("浏览器导航失败 (%s)", result.ErrorText)
	}
	return nil
}

func (p *browserDebugSession) url(ctx context.Context) (string, error) {
	var result struct {
		FrameTree struct {
			Frame struct {
				URL string `json:"url"`
			} `json:"frame"`
		} `json:"frameTree"`
	}
	if err := p.call(ctx, "Page.getFrameTree", nil, &result); err != nil {
		return "", err
	}
	return normalizeDebugPage(result.FrameTree.Frame.URL)
}

type browserDebugNode struct {
	Role  string `json:"role"`
	Label string `json:"label,omitempty"`
	Depth int    `json:"depth"`
}

func (p *browserDebugSession) inspect(ctx context.Context) ([]browserDebugNode, error) {
	if _, err := p.url(ctx); err != nil {
		return nil, errors.New("请先打开网页")
	}
	type value struct {
		Value json.RawMessage `json:"value"`
	}
	type node struct {
		ID         string   `json:"nodeId"`
		Parent     string   `json:"parentId"`
		Children   []string `json:"childIds"`
		Role       value    `json:"role"`
		Name       value    `json:"name"`
		Ignored    bool     `json:"ignored"`
		Properties []struct {
			Name string `json:"name"`
		} `json:"properties"`
	}
	var result struct {
		Nodes []node `json:"nodes"`
	}
	if err := p.call(ctx, "Accessibility.getFullAXTree", map[string]any{"depth": 7}, &result); err != nil {
		return nil, err
	}
	index := make(map[string]node, len(result.Nodes))
	for _, item := range result.Nodes {
		index[item.ID] = item
	}
	output := make([]browserDebugNode, 0, 200)
	var walk func(node, int)
	walk = func(item node, depth int) {
		if depth > 8 || len(output) >= 200 {
			return
		}
		var role, label string
		_ = json.Unmarshal(item.Role.Value, &role)
		editable := false
		switch strings.ToLower(role) {
		case "textbox", "textfield", "textfieldwithcombobox", "searchbox", "combobox", "spinbutton":
			editable = true
		}
		for _, property := range item.Properties {
			if property.Name == "editable" {
				editable = true
				break
			}
		}
		if !item.Ignored && role != "" {
			if !editable {
				_ = json.Unmarshal(item.Name.Value, &label)
			}
			output = append(output, browserDebugNode{Role: browserNodeString(role, 64), Label: browserNodeString(label, 200), Depth: depth})
		}
		if editable {
			// 不输出可编辑控件的文本内容，避免把用户在页面里填写的敏感信息带进模型上下文。
			return
		}
		for _, id := range item.Children {
			if child, ok := index[id]; ok {
				walk(child, depth+1)
			}
		}
	}
	for _, item := range result.Nodes {
		if item.Parent == "" {
			walk(item, 0)
		}
	}
	return output, nil
}

func browserNodeString(value string, limit int) string {
	runes := []rune(strings.Join(strings.Fields(value), " "))
	return string(runes[:min(len(runes), limit)])
}

func (p *browserDebugSession) screenshot(ctx context.Context) (string, error) {
	if _, err := p.url(ctx); err != nil {
		return "", errors.New("请先打开网页")
	}
	var screenshot struct {
		Data string `json:"data"`
	}
	if err := p.call(ctx, "Page.captureScreenshot", map[string]any{"format": "png", "captureBeyondViewport": false}, &screenshot); err != nil {
		return "", err
	}
	if screenshot.Data == "" || len(screenshot.Data) > 7<<20 {
		return "", errors.New("截图为空或超过大小限制")
	}
	return screenshot.Data, nil
}
