package config

import (
	"fmt"
	"net/url"
	"strings"
)

// OllamaEndpoints 同时接受服务根地址、/v1 和 /api，保留反向代理路径前缀。
func OllamaEndpoints(raw string) (root, chat string, err error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || len(raw) > 4096 || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return "", "", fmt.Errorf("Ollama 地址必须为有效的 HTTP(S) 服务地址，且不含认证信息、查询或片段")
	}
	path := strings.TrimRight(u.Path, "/")
	for _, suffix := range []string{"/chat/completions", "/api/chat", "/api/tags"} {
		if strings.HasSuffix(path, suffix) {
			return "", "", fmt.Errorf("请填写 Ollama 服务根地址，例如 http://127.0.0.1:11434，不要填写具体接口路径")
		}
	}
	if strings.HasSuffix(path, "/v1") {
		path = strings.TrimSuffix(path, "/v1")
	} else {
		path = strings.TrimSuffix(path, "/api")
	}
	u.Path, u.RawPath = path, ""
	root = strings.TrimRight(u.String(), "/")
	return root, root + "/v1", nil
}
