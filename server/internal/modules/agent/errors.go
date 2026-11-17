package agent

import (
	"context"
	"errors"
	"fmt"
	"net"

	"github.com/cloudwego/eino-ext/components/model/openai"
	upstream "github.com/meguminnnnnnnnn/go-openai"
)

var ErrEmptyResponse = errors.New("模型没有返回可显示的文本")

// ErrorMessage intentionally uses fixed descriptions. Provider messages can
// contain credentials, request bodies or private gateway URLs and must never be
// sent to the UI or stored in the conversation history verbatim.
func ErrorMessage(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.Canceled) {
		return "回复已停止。"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "模型响应超时，请稍后重试。"
	}
	if errors.Is(err, ErrEmptyResponse) {
		return "模型未返回可显示的文本，请检查模型是否支持对话及输出 token 上限。"
	}
	var network net.Error
	if errors.As(err, &network) {
		if network.Timeout() {
			return "模型响应超时，请稍后重试。"
		}
		return "无法连接模型服务，请检查服务地址、网络或代理设置。"
	}
	status := 0
	var apiError *openai.APIError
	var streamError *upstream.APIError
	var requestError *upstream.RequestError
	switch {
	case errors.As(err, &apiError):
		status = apiError.HTTPStatusCode
	case errors.As(err, &streamError):
		status = streamError.HTTPStatusCode
	case errors.As(err, &requestError):
		status = requestError.HTTPStatusCode
	}
	switch status {
	case 401:
		return "模型服务认证失败（401），请检查 API Key。"
	case 403:
		return "模型服务拒绝访问（403），请检查密钥权限及可用区域。"
	case 404:
		return "模型或接口不存在（404），请检查模型名称和 Base URL。"
	case 400, 422:
		return fmt.Sprintf("模型服务拒绝了请求参数（%d），请检查模型是否支持当前输入及工具调用。", status)
	case 429:
		return "模型服务限流或额度不足（429），请检查额度后重试。"
	}
	if status >= 500 {
		return fmt.Sprintf("模型服务暂时不可用（%d），请稍后重试。", status)
	}
	if errors.Is(err, upstream.ErrReasoningModelLimitationsOther) || errors.Is(err, upstream.ErrReasoningModelMaxTokensDeprecated) {
		return "当前模型不支持所选的生成参数，请调整模型设置。"
	}
	return "模型请求失败，请检查模型服务设置后重试。"
}
