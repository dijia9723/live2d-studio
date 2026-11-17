// Package sceneassets 管理场景背景素材（图片与视频）的上传、删除与读取。
// 管理接口前缀为 /api/v1/scene-assets，媒体文件通过 /scene-media/*path 只读提供。
package sceneassets

import "github.com/gin-gonic/gin"

// Module 注册素材管理接口与只读媒体路由。
type Module struct{ Service *Service }

// Register 挂载素材列表、上传与删除接口。
func (m *Module) Register(r *gin.RouterGroup) {
	r.GET("/scene-assets", m.list)
	r.POST("/scene-assets", m.upload)
	r.DELETE("/scene-assets/:id", m.remove)
}

// RegisterMedia 在 /api/v1 之外挂载只读媒体路由，供 <img>/<video> 直接引用；
// 同时注册 HEAD，便于浏览器在播放前探测资源是否存在。
func (m *Module) RegisterMedia(r *gin.Engine) {
	r.GET("/scene-media/*path", m.media)
	r.HEAD("/scene-media/*path", m.media)
}
