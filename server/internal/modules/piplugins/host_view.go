// host_view.go 负责把插件面板 HTML 重写为内联资源并注入 CSP 的隔离视图。
package piplugins

import (
	"bytes"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"mime"
	"net/url"
	"path"
	"slices"
	"strings"

	"server/internal/pkg"

	"github.com/gin-gonic/gin"
	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

//go:embed host_bridge.js
var hostFrameBridge string

// hostFrameCSP 禁止面板发起网络请求、加载子框架或提交表单，只允许内联脚本与 data: 资源，
// 从而把插件界面限制在完全离线的沙箱中。
const hostFrameCSP = "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; " +
	"img-src data:; media-src data:; font-src data:; connect-src 'none'; object-src 'none'; " +
	"frame-src 'none'; form-action 'none'; base-uri 'none'; worker-src 'none'"

func (m *Module) hostView(c *gin.Context) {
	item, ok := m.hostRequire(c)
	if !ok {
		return
	}
	var input struct {
		ID string `json:"id"`
	}
	if c.ShouldBindJSON(&input) != nil {
		pkg.Fail(c, 400, "请选择插件面板或视图")
		return
	}
	spec := item.Manifest.hostSpec()
	index := slices.IndexFunc(spec.Views, func(view hostView) bool { return view.ID == input.ID })
	if index < 0 {
		pkg.Fail(c, 404, "此插件未声明该视图")
		return
	}
	view := spec.Views[index]
	result, err := isolatedHostHTML(item, view.Entry)
	if err != nil {
		pkg.Fail(c, 400, err.Error())
		return
	}
	pkg.OK(c, gin.H{"html": result, "title": firstText(string(view.Title), spec.Name)})
}

// isolatedHostHTML 解析插件页面，移除 iframe、外部链接与内联元信息，
// 把同包资源改写为 data: URI 后注入桥接脚本与 CSP，形成可安全预览的离线文档。
func isolatedHostHTML(item Installation, entry string) (string, error) {
	source, err := readHostEntry(item.Root, entry, 512<<10)
	if err != nil {
		return "", err
	}
	doc, err := html.Parse(bytes.NewReader(source))
	if err != nil {
		return "", errors.New("无法解析插件页面")
	}
	var head *html.Node
	remaining := int64(3 << 20)
	var walk func(*html.Node, int)
	walk = func(parent *html.Node, depth int) {
		if depth > 150 {
			for parent.FirstChild != nil {
				parent.RemoveChild(parent.FirstChild)
			}
			return
		}
		for node := parent.FirstChild; node != nil; {
			next := node.NextSibling
			if node.Type != html.ElementNode {
				node = next
				continue
			}
			tag := node.Data
			if tag == "head" && node.Namespace == "" {
				head = node
			}
			if node.Namespace != "" || slices.Contains([]string{"iframe", "frame", "object", "embed", "base"}, tag) ||
				(tag == "meta" && attribute(node, "http-equiv") != "") ||
				(tag == "link" && !strings.EqualFold(attribute(node, "rel"), "stylesheet")) {
				parent.RemoveChild(node)
				node = next
				continue
			}
			attrs := node.Attr[:0]
			for _, attr := range node.Attr {
				switch attr.Key {
				case "href":
					if tag == "link" {
						attr.Val = hostAsset(item.Root, entry, attr.Val, "css", &remaining)
					} else if tag != "a" || !strings.HasPrefix(attr.Val, "#") {
						continue
					}
				case "src":
					kind := "image"
					switch tag {
					case "script":
						kind = "js"
					case "audio", "video", "source":
						kind = "media"
					case "img", "input":
					default:
						continue
					}
					attr.Val = hostAsset(item.Root, entry, attr.Val, kind, &remaining)
					if attr.Val == "" {
						continue
					}
				case "poster":
					attr.Val = hostAsset(item.Root, entry, attr.Val, "image", &remaining)
				case "srcset", "ping", "action", "formaction", "background", "target", "crossorigin", "integrity", "nonce", "autofocus":
					continue
				}
				attrs = append(attrs, attr)
			}
			node.Attr = attrs
			walk(node, depth+1)
			node = next
		}
	}
	walk(doc, 0)
	if head == nil {
		return "", errors.New("插件页面没有可加载的文档头")
	}
	csp := &html.Node{Type: html.ElementNode, DataAtom: atom.Meta, Data: "meta", Attr: []html.Attribute{
		{Key: "http-equiv", Val: "Content-Security-Policy"}, {Key: "content", Val: hostFrameCSP},
	}}
	shim := &html.Node{Type: html.ElementNode, DataAtom: atom.Script, Data: "script"}
	shim.AppendChild(&html.Node{Type: html.TextNode, Data: hostFrameBridge})
	head.InsertBefore(shim, head.FirstChild)
	head.InsertBefore(csp, shim)
	var output bytes.Buffer
	if err := html.Render(&output, doc); err != nil || output.Len() > 5<<20 {
		return "", errors.New("插件页面超出预览大小限制")
	}
	return output.String(), nil
}

func attribute(node *html.Node, name string) string {
	for _, attr := range node.Attr {
		if attr.Key == name {
			return attr.Val
		}
	}
	return ""
}

// hostAsset 只内联包内相对路径的允许类型资源，拒绝绝对 URL、上级路径与协议外链，
// 并按剩余预算递减，避免单个面板耗尽内存。
func hostAsset(root, page, raw, kind string, remaining *int64) string {
	if *remaining <= 0 {
		return ""
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.IsAbs() || u.Host != "" || u.Path == "" || strings.HasPrefix(u.Path, "/") || u.User != nil {
		return ""
	}
	target := path.Clean(path.Join(path.Dir(page), u.Path))
	ext := extension(target)
	contentType := mime.TypeByExtension(ext)
	switch kind {
	case "js":
		if ext != ".js" && ext != ".mjs" {
			return ""
		}
		contentType = "text/javascript"
	case "css":
		if ext != ".css" {
			return ""
		}
		contentType = "text/css"
	case "image":
		if !slices.Contains([]string{".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico"}, ext) {
			return ""
		}
	case "media":
		if !strings.HasPrefix(contentType, "audio/") && !strings.HasPrefix(contentType, "video/") {
			return ""
		}
	}
	content, err := readHostEntry(root, target, min(*remaining, 768<<10))
	if err != nil || contentType == "" {
		return ""
	}
	*remaining -= int64(len(content))
	return "data:" + contentType + ";base64," + base64.StdEncoding.EncodeToString(content)
}

// hostBridge 处理隔离面板发来的桥接调用：内置方法在此直接响应，
// 其余方法作为 panel 操作转发给插件进程。
func (m *Module) hostBridge(c *gin.Context) {
	item, ok := m.hostRequire(c)
	if !ok {
		return
	}
	if len(item.Manifest.hostSpec().Views) == 0 {
		pkg.Fail(c, 409, "插件未声明可使用桥接的面板或视图")
		return
	}
	var input struct {
		Method  string               `json:"method"`
		Payload json.RawMessage      `json:"payload"`
		Context HostWorkspaceContext `json:"context"`
	}
	if c.ShouldBindJSON(&input) != nil || !hostMemberID.MatchString(input.Method) || len(input.Payload) > workerDataLimit {
		pkg.Fail(c, 400, "插件面板请求无效")
		return
	}
	events := []hostEvent{}
	var value any
	ctx := WithHostWorkspace(c.Request.Context(), input.Context)
	if workspaceMethod(input.Method) {
		result, err := m.invokeWorkspace(ctx, item, input.Method, input.Payload)
		if err != nil {
			pkg.Fail(c, 403, err.Error())
			return
		}
		pkg.OK(c, gin.H{"value": result, "events": events})
		return
	}
	switch input.Method {
	case "app.getAppearance":
		value = gin.H{"base": "dark", "locale": "zh-CN"}
	case "app.getLocale":
		value = "zh-CN"
	case "plugin.getId":
		value = item.Manifest.ID
	case "plugin.getSettings":
		m.host.dataMu.Lock()
		value = m.readHostData(item).Settings
		m.host.dataMu.Unlock()
	case "plugin.setSettings":
		var update map[string]json.RawMessage
		if json.Unmarshal(input.Payload, &update) != nil {
			pkg.Fail(c, 400, "插件设置格式无效")
			return
		}
		settings, err := m.storeHostSettings(item, update)
		if err != nil {
			pkg.Fail(c, 400, err.Error())
			return
		}
		m.syncHostSettings(c.Request.Context(), item, settings)
		value = settings
	case "ui.showToast":
		if !slices.Contains(item.Manifest.Permissions, "notify") && !slices.Contains(item.Manifest.Permissions, "ui.panel") {
			pkg.Fail(c, 403, "插件未声明通知权限")
			return
		}
		var toast struct {
			Message string
			Text    string
		}
		var text string
		if json.Unmarshal(input.Payload, &toast) == nil {
			text = firstText(toast.Message, toast.Text)
		} else {
			_ = json.Unmarshal(input.Payload, &text)
		}
		if text != "" {
			events = append(events, hostEvent{Type: "toast", Text: clipHostText(text, 400)})
		}
		value = true
	default:
		result, err := m.executeHost(ctx, item, hostRequest{Operation: "panel", ID: input.Method, Payload: input.Payload}, 0)
		if err != nil {
			pkg.Fail(c, 409, err.Error())
			return
		}
		value, events = result.Result, result.Events
	}
	pkg.OK(c, gin.H{"value": value, "events": events})
}
