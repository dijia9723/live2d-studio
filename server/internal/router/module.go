// Package router 定义业务模块的路由注册契约，把各模块统一挂载到 /api/v1。
package router

import "github.com/gin-gonic/gin"

// Module 由各业务模块实现，负责把自己的处理器注册到 API 分组上。
type Module interface{ Register(*gin.RouterGroup) }

// Register 创建 /api/v1 分组并按传入顺序注册所有模块。
func Register(r *gin.Engine, modules ...Module) {
	api := r.Group("/api/v1")
	for _, m := range modules {
		m.Register(api)
	}
}
