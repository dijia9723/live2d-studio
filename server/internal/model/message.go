// 本文件定义消息表与工具调用轨迹：聊天记录按会话与时间复合索引读取。

package model

import "time"

// Message 是会话中的一条消息，可能是用户输入、角色回复，或失败/中断的占位。
// Status 取值：complete 正常完成，failed 调用失败，interrupted 被用户中断。
type Message struct {
	ID string `gorm:"primaryKey;size:64" json:"id"`
	// ConversationID 与 CreatedAt 组成复合索引，支撑按时间顺序读取历史。
	ConversationID string `gorm:"index;index:idx_messages_conversation_order,priority:1" json:"conversation_id"`
	// Role 为 system/user/assistant/tool 等角色标识。
	Role    string `json:"role"`
	Content string `json:"content"`
	// Image 保存用户附图（data URL），可为空。
	Image  string `json:"image,omitempty"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
	// ToolRuns 以 JSON 序列化存储，避免为执行轨迹额外建表。
	ToolRuns  []ToolRun `gorm:"serializer:json" json:"tool_runs,omitempty"`
	CreatedAt time.Time `gorm:"index;index:idx_messages_conversation_order,priority:2" json:"created_at"`
}

// ToolRun 记录一次工具调用的名称与最终状态，用于前端展示执行轨迹。
type ToolRun struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

// 工具调用的三种终态/过程状态。
const (
	ToolRunning   = "running"
	ToolCompleted = "completed"
	ToolFailed    = "failed"
)
