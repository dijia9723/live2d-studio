package router

import "github.com/gin-gonic/gin"

type Module interface{ Register(*gin.RouterGroup) }

func Register(r *gin.Engine, modules ...Module) {
	api := r.Group("/api/v1")
	for _, m := range modules {
		m.Register(api)
	}
}
