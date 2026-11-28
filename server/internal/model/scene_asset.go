// 本文件定义场景素材表，文件本体存于数据目录的 scene-media。

package model

import "time"

// SceneAsset 描述一个已上传的场景素材。
type SceneAsset struct {
	ID   string `gorm:"primaryKey;size:64" json:"id"`
	Name string `json:"name"`
	// Kind 取值为 image、video 或 html，不信任客户端声明的 MIME 类型。
	Kind     string `gorm:"size:10" json:"kind"`
	MIMEType string `gorm:"size:50" json:"mime_type"`
	Size     int64  `json:"size"`
	// Filename 是磁盘上的存储名，唯一且不对外暴露；外部通过 URL 访问。
	Filename string `gorm:"uniqueIndex;size:80" json:"-"`
	// URL 是运行时拼出的访问路径（/scene-media/<id><ext>），不落库。
	URL       string    `gorm:"-" json:"url"`
	CreatedAt time.Time `gorm:"index" json:"created_at"`
}
