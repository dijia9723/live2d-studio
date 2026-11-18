// 本文件实现桌面外壳的资源代理，把页面资源与业务 API 分流到本地监听地址。

package webui

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
)

// DesktopHandler 构建桌面外壳使用的资源代理：页面资源留在 Wails 源上（原生
// 运行时才能工作），业务请求则转发到真实的回环 HTTP 监听地址。Wails 在
// Windows 上的资源响应会整体缓冲，无法流式转发 SSE；若聊天接口走它，
// 每个 token 都会被延迟到整段生成结束。
//
// 代理只接受回环目标，避免误把本地服务暴露给远端；HTML 响应会在 <head>
// 之后注入 window.__STUDIO_API_BASE_URL__，让前端直接访问真实监听地址。
func DesktopHandler(address string) (http.Handler, error) {
	target, err := url.Parse(address)
	if err != nil || target.Scheme != "http" || target.Host == "" || target.User != nil || target.RawQuery != "" || target.Fragment != "" || target.Path != "" {
		return nil, fmt.Errorf("桌面服务地址无效")
	}
	host := target.Hostname()
	if host != "localhost" && (net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback()) {
		return nil, fmt.Errorf("桌面服务必须使用回环地址")
	}
	base, _ := json.Marshal(address + "/api/v1")
	script := []byte("<script>window.__STUDIO_API_BASE_URL__=" + string(base) + ";</script>")
	petRuntime := []byte(`<script type="module" src="/wails/runtime.js"></script>`)
	proxy := httputil.NewSingleHostReverseProxy(target)
	director := proxy.Director
	proxy.Director = func(r *http.Request) {
		originalHost := r.Host
		origin := r.Header.Get("Origin")
		director(r)
		r.Host = target.Host
		// HTML 必须保持未压缩，才能在响应体中注入启动配置。
		r.Header.Set("Accept-Encoding", "identity")
		// 同源请求改写为真实监听地址的 Origin，以满足后端的来源校验。
		if origin == "http://"+originalHost || origin == "https://"+originalHost {
			r.Header.Set("Origin", target.Scheme+"://"+target.Host)
		}
	}
	proxy.ModifyResponse = func(r *http.Response) error {
		if r.StatusCode != http.StatusOK || r.Request.Method == http.MethodHead || !strings.HasPrefix(r.Header.Get("Content-Type"), "text/html") {
			return nil
		}
		defer r.Body.Close()
		const maxHTML = 2 << 20
		body, err := io.ReadAll(io.LimitReader(r.Body, maxHTML+1))
		if err != nil {
			return err
		}
		if len(body) > maxHTML {
			return fmt.Errorf("桌面页面超出大小限制")
		}
		// 在任何模块开始使用 API 客户端之前完成注入。
		if !bytes.Contains(body, []byte("<head>")) {
			return fmt.Errorf("桌面页面缺少 head 元素")
		}
		head := append([]byte("<head>"), script...)
		if r.Request.URL.Query().Get("pet") == "1" {
			head = append(head, petRuntime...)
		}
		body = bytes.Replace(body, []byte("<head>"), head, 1)
		r.Body = io.NopCloser(bytes.NewReader(body))
		r.ContentLength = int64(len(body))
		r.Header.Set("Content-Length", strconv.Itoa(len(body)))
		r.Header.Set("Cache-Control", "no-store")
		r.Header.Del("ETag")
		return nil
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(w, "本地桌面服务暂时不可用", http.StatusBadGateway)
	}
	return proxy, nil
}
