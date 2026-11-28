/**
 * 文件职责：角色对话历史列表。
 * 支持搜索、打开、重命名与删除对话，并在删除当前对话后回到角色选择。
 */
import { useState } from 'react'
import { MessageSquare, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { api } from '../../api/client'
import { emptyDraft, updateDraft } from '../../store/chatDrafts'
import { useStudio } from '../../store/studio'
import type { Conversation } from '../../types/api'
import { shortDate } from '../../utils/format'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'

/** 对话历史面板属性。 */
interface Props {
  characterID: string
  characterName: string
  onStart: () => void
  /** 成功打开对话后的回调 */
  onOpen: () => void
}

/** 角色对话历史面板。 */
export default function ConversationHistory({
  characterID,
  characterName,
  onStart,
  onOpen,
}: Props) {
  const conversations = useStudio((s) => s.conversations)
  const activeID = useStudio((s) => s.conversationID)
  const busy = useStudio((s) => s.busy)
  const [search, setSearch] = useState('')
  const [opening, setOpening] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [action, setAction] = useState<{
    kind: 'rename' | 'delete'
    conversation: Conversation
  } | null>(null)
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState('')
  const trimmedTitle = title.trim()
  // 按码点计数，避免 emoji 等代理对被算成两个字符。
  const titleValid = trimmedTitle.length > 0 && Array.from(trimmedTitle).length <= 100
  const query = search.trim().toLowerCase()
  const characterHistory = conversations.filter((item) => item.character_id === characterID)
  const filtered = characterHistory.filter((item) => item.title.toLowerCase().includes(query))

  const open = async (conversation: Conversation) => {
    setOpening(true)
    setHistoryError('')
    try {
      if (await useStudio.getState().openConversation(conversation)) onOpen()
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '无法打开对话')
    } finally {
      setOpening(false)
    }
  }

  const updateConversation = async () => {
    if (!action || saving || (action.kind === 'rename' && !titleValid)) return
    const { id } = action.conversation
    setSaving(true)
    setActionError('')
    try {
      if (action.kind === 'delete') {
        await api.deleteConversation(id)
        const studio = useStudio.getState()
        // 删除的是当前打开的对话时，退回角色选择，避免停留在已失效的会话。
        if (studio.conversationID === id) studio.selectCharacter(studio.characterID)
        useStudio.setState((state) => ({
          conversations: state.conversations.filter((item) => item.id !== id),
        }))
        // 同步清掉本地草稿，防止新建对话时带出已删除会话的输入。
        updateDraft(id, () => emptyDraft)
      } else {
        await api.renameConversation(id, trimmedTitle)
        useStudio.setState((state) => ({
          conversations: state.conversations.map((item) =>
            item.id === id ? { ...item, title: trimmedTitle } : item,
          ),
        }))
      }
      setAction(null)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '无法更新对话')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="conversation-history">
      <header className="history-heading">
        <h2>{characterName}的对话记录</h2>
        <button type="button" className="button primary" onClick={onStart} disabled={busy}>
          <Plus size={16} aria-hidden="true" /> 新对话
        </button>
      </header>
      {characterHistory.length > 0 && (
        <label className="history-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索对话标题"
            placeholder="搜索对话标题"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      )}
      {historyError && (
        <p className="history-error" role="alert">
          {historyError}
        </p>
      )}
      {filtered.length > 0 ? (
        <ul className="history-list" aria-label="已保存的对话" aria-busy={opening}>
          {filtered.map((item) => (
            <li className="history-entry" key={item.id}>
              <button
                type="button"
                className="history-select"
                aria-current={item.id === activeID ? 'true' : undefined}
                disabled={busy || opening}
                onClick={() => void open(item)}
              >
                <MessageSquare size={16} aria-hidden="true" />
                <span>
                  <strong title={item.title}>{item.title}</strong>
                  <small>{shortDate(item.updated_at)}</small>
                </span>
              </button>
              <button
                type="button"
                className="history-action"
                aria-label={`重命名 ${item.title}`}
                title="重命名对话"
                onClick={() => {
                  setTitle(item.title)
                  setActionError('')
                  setAction({ kind: 'rename', conversation: item })
                }}
              >
                <Pencil size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="history-action"
                aria-label={`删除 ${item.title}`}
                title="删除对话"
                disabled={busy || opening}
                onClick={() => {
                  setActionError('')
                  setAction({ kind: 'delete', conversation: item })
                }}
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="history-placeholder">
          {characterHistory.length ? '没有匹配的对话' : '还没有和这个角色的对话记录。'}
        </p>
      )}
      <Dialog open={!!action} onOpenChange={(open) => !open && !saving && setAction(null)}>
        <DialogContent
          className="modal shell-dialog"
          showCloseButton={false}
          // 保存过程中禁止 Esc/点击外部关闭，避免请求结果到达时弹窗状态已丢失。
          onEscapeKeyDown={(event) => {
            if (saving) event.preventDefault()
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          {action && (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void updateConversation()
              }}
            >
              {action.kind === 'delete' ? (
                <>
                  <DialogTitle>删除对话？</DialogTitle>
                  <DialogDescription>
                    「{action.conversation.title}」及其中的消息将被删除。
                  </DialogDescription>
                </>
              ) : (
                <>
                  <DialogTitle>重命名对话</DialogTitle>
                  <DialogDescription>标题最多 100 个字符。</DialogDescription>
                  <label className="form-field">
                    对话标题
                    <input
                      autoFocus
                      disabled={saving}
                      value={title}
                      maxLength={200}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  </label>
                </>
              )}
              {actionError && (
                <p className="dialog-error" role="alert">
                  {actionError}
                </p>
              )}
              <div className="modal-actions">
                <button
                  className="button ghost"
                  type="button"
                  autoFocus={action.kind === 'delete'}
                  disabled={saving}
                  onClick={() => setAction(null)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className={`button ${action.kind === 'delete' ? 'danger' : 'primary'}`}
                  disabled={saving || (action.kind === 'rename' && !titleValid)}
                >
                  {action.kind === 'delete'
                    ? saving
                      ? '删除中…'
                      : '删除对话'
                    : saving
                      ? '保存中…'
                      : '保存标题'}
                </button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
