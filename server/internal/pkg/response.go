// Package pkg 提供跨模块复用的轻量工具，目前包含统一的 HTTP 响应格式。
package pkg

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// Response 是所有接口的统一响应体：Code 为 0 表示成功，非 0 时与 HTTP 状态码一致。
type Response struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// OK 以 200 返回成功响应，业务数据放在 data 字段。
func OK(c *gin.Context, data any) {
	c.JSON(http.StatusOK, Response{Code: 0, Message: "ok", Data: data})
}

// Fail 以指定状态码返回错误并终止后续处理，message 会直接展示给用户。
func Fail(c *gin.Context, status int, message string) {
	c.AbortWithStatusJSON(status, Response{Code: status, Message: message})
}
