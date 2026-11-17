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

// DesktopHandler keeps page assets on the Wails origin, where the native runtime
// works, but points business requests at the real loopback HTTP listener. Wails'
// Windows asset response writer buffers a whole response and cannot stream SSE;
// routing the chat API through it delays every token until generation finishes.
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
	proxy := httputil.NewSingleHostReverseProxy(target)
	director := proxy.Director
	proxy.Director = func(r *http.Request) {
		originalHost := r.Host
		origin := r.Header.Get("Origin")
		director(r)
		r.Host = target.Host
		// HTML must stay uncompressed so the startup configuration can be added.
		r.Header.Set("Accept-Encoding", "identity")
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
		// Inject before any module in the document starts using the API client.
		if !bytes.Contains(body, []byte("<head>")) {
			return fmt.Errorf("桌面页面缺少 head 元素")
		}
		body = bytes.Replace(body, []byte("<head>"), append([]byte("<head>"), script...), 1)
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
