// Package tools 提供 AI Agent 工具的统一入口。
//
// 建议直接导入子 package 使用：
//
//	import "agentp/tools/knowledge"
//	import "agentp/tools/shell"
//	import "agentp/tools/cron"
package tools

import (
	cronPkg "agentp/cron"
	aggomemory "agentp/memory"
	"agentp/tools/cron"
	"agentp/tools/database"
	"agentp/tools/knowledge"
	memorytool "agentp/tools/memory"
	"agentp/tools/shell"

	"github.com/cloudwego/eino/components/indexer"
	"github.com/cloudwego/eino/components/retriever"
	"github.com/cloudwego/eino/components/tool"
	"gorm.io/gorm"
)

// ============================================================
// Database 工具
// ============================================================

// GetDatabaseTools 获取通用数据库执行工具（支持所有gorm兼容的数据库，如MySQL, PostgreSQL等）
func GetDatabaseTools(db *gorm.DB, opts ...database.Option) []tool.BaseTool {
	return database.GetTools(db, opts...)
}

// ============================================================
// Knowledge 工具
// ============================================================

// GetKnowledgeTools 获取知识库管理工具
func GetKnowledgeTools(indexer indexer.Indexer, retriever retriever.Retriever, retrieverOptions *retriever.Options) []tool.BaseTool {
	return knowledge.GetTools(indexer, retriever, retrieverOptions)
}

// GetKnowledgeReasoningTools 获取知识推理工具
func GetKnowledgeReasoningTools(r retriever.Retriever, retrieverOptions []retriever.Option) []tool.BaseTool {
	return knowledge.GetReasoningTools(r, retrieverOptions)
}

// ============================================================
// Shell 工具
// ============================================================

// GetShellTools 获取全部 Shell 工具
func GetShellTools(opts ...shell.Option) []tool.BaseTool {
	return shell.GetTools(opts...)
}

// GetExecuteTools 获取命令执行工具
func GetExecuteTools(opts ...shell.Option) []tool.BaseTool {
	return shell.GetExecuteTools(opts...)
}

// ============================================================
// Cron 定时任务工具
// ============================================================

// GetCronTools 获取定时任务工具
func GetCronTools(service *cronPkg.CronService, opts ...cron.CronOption) []tool.BaseTool {
	return cron.GetTools(service, opts...)
}

// ============================================================
// Memory 工具
// ============================================================

// GetUserMemorySearchTool 获取按事件检索用户长期记忆的工具。
// 入参可以是 memory.MemoryProvider 也可以直接是 UserMemoryEventSearcher；
// 如果传入的 provider 不支持事件检索（例如 mem0/memu），返回 nil 工具与无错误，由调用方决定是否注册。
func GetUserMemorySearchTool(provider any) (tool.BaseTool, error) {
	searcher, ok := provider.(aggomemory.UserMemoryEventSearcher)
	if !ok {
		return nil, nil
	}
	return memorytool.SearchUserMemoryTool(searcher)
}
