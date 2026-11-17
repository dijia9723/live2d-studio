/**
 * 文件职责：按会话隔离的聊天输入草稿（文本 + 待发送图片）。
 * 草稿只存在内存中，切换会话时不会互相覆盖；新建会话的草稿会迁移到服务器分配的 ID 下。
 */
import { create } from 'zustand'

type Draft = { text: string; image: string }
type Drafts = Record<string, Draft>

export const emptyDraft: Draft = { text: '', image: '' }
export const useChatDrafts = create<Drafts>(() => ({}))

/** 生成草稿键：已有会话用会话 ID，未创建会话时用 new:角色ID 占位。 */
export function draftKey(conversationID: string | null, characterID: string) {
  return conversationID ?? `new:${characterID}`
}

/** 更新指定草稿；内容清空时删除该键，避免内存里堆积空草稿。 */
export function updateDraft(key: string, update: (draft: Draft) => Draft) {
  useChatDrafts.setState((drafts) => {
    const next = update(drafts[key] ?? emptyDraft)
    if (next.text || next.image) return { ...drafts, [key]: next }
    if (!drafts[key]) return drafts
    const remaining = { ...drafts }
    delete remaining[key]
    return remaining
  }, true)
}

/** 会话由暂存键变为真实 ID 时迁移草稿。 */
export function moveDraft(from: string, to: string) {
  useChatDrafts.setState((drafts) => {
    if (!drafts[from]) return drafts
    const next = { ...drafts, [to]: drafts[from] }
    delete next[from]
    return next
  }, true)
}
