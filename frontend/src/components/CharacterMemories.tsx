/**
 * 文件职责：角色记忆管理弹窗。
 * 支持从聊天消息带入草稿、新增/编辑/删除记忆以及搜索过滤；
 * 数据通过 AbortController 在角色切换或重试时取消旧请求。
 */
import { useEffect, useRef, useState } from 'react'
import { Brain, LoaderCircle, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import { api } from '../api/client'
import type { Character, CharacterMemory } from '../types/api'
import { shortDate } from '../utils/format'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

const maxLength = 300

/**
 * @param character 当前管理记忆的角色
 * @param initialDraft 从聊天消息带入的初始内容（存在时聚焦输入框）
 * @param onClose 关闭弹窗回调
 */
export default function CharacterMemories({
  character,
  initialDraft,
  onClose,
}: {
  character: Character
  initialDraft?: string
  onClose: () => void
}) {
  const input = useRef<HTMLTextAreaElement>(null)
  const [memories, setMemories] = useState<CharacterMemory[] | null>(null)
  const [newDraft, setNewDraft] = useState(() => {
    const content = initialDraft?.trim() ?? ''
    return { content, fromChat: Boolean(content) }
  })
  const [editing, setEditing] = useState<Pick<CharacterMemory, 'id' | 'content'> | null>(null)
  const [removingID, setRemovingID] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [request, setRequest] = useState(0)
  const [search, setSearch] = useState('')
  const draft = editing?.content ?? newDraft.content
  const content = draft.trim()
  const length = Array.from(content).length
  const fromChat = !editing && newDraft.fromChat
  const loaded = memories !== null
  const query = search.trim().toLowerCase()
  const matchingMemories = memories?.filter((memory) =>
    memory.content.toLowerCase().includes(query),
  )

  // 读取记忆；request 自增可触发“重新加载”，signal 防止切换角色后写入旧数据。
  useEffect(() => {
    const controller = new AbortController()
    void api.characterMemories(character.id, controller.signal).then(
      (items) => {
        if (!controller.signal.aborted) setMemories(items)
      },
      (cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message)
      },
    )
    return () => controller.abort()
  }, [character.id, request])

  // 记忆读取完成后聚焦输入框，方便直接确认从聊天带入的内容。
  useEffect(() => {
    if (loaded && fromChat) input.current?.focus({ preventScroll: true })
  }, [loaded, fromChat])

  const close = () => {
    if (busy) return
    onClose()
  }

  const edit = (memory: CharacterMemory) => {
    setEditing({ id: memory.id, content: memory.content })
    setError('')
    setStatus('')
    input.current?.focus()
  }

  // 保存后按 updated_at 判断是否需要重排，未变化视为重复内容。
  const save = async () => {
    if (!memories || busy || removingID || !length || length > maxLength) return
    setBusy(true)
    setError('')
    setStatus('')
    try {
      const saved = await api.saveCharacterMemory(character.id, content, editing?.id)
      const previous = memories.find((memory) => memory.id === saved.id)
      if (previous?.updated_at !== saved.updated_at) {
        setMemories([saved, ...memories.filter((memory) => memory.id !== saved.id)])
      }
      if (editing) setEditing(null)
      else setNewDraft({ content: '', fromChat: false })
      setStatus(editing ? '已保存修改' : previous ? '这条记忆已存在' : '已添加记忆')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存记忆失败')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    if (!memories || busy) return
    setBusy(true)
    setError('')
    setStatus('')
    try {
      await api.deleteCharacterMemory(character.id, id)
      setMemories(memories.filter((memory) => memory.id !== id))
      setRemovingID('')
      if (editing?.id === id) setEditing(null)
      setStatus('已删除记忆')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除记忆失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        className="modal character-dialog character-memories"
        showCloseButton={false}
        aria-labelledby="character-memories-title"
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <header className="character-dialog-heading">
          <span className="character-dialog-icon">
            <Brain size={21} />
          </span>
          <div>
            <DialogTitle asChild>
              <h2 id="character-memories-title">{character.name} 的记忆</h2>
            </DialogTitle>
            <p>在不同会话中，角色会参考最近更新的 8 条记忆。</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭记忆管理"
            disabled={busy}
            onClick={close}
          >
            <X size={20} />
          </button>
        </header>
        {!memories && (
          <div className="memory-initial">
            {error ? (
              <>
                <p className="memory-error" role="alert">
                  {error}
                </p>
                <button
                  type="button"
                  className="button ghost"
                  onClick={() => {
                    setError('')
                    setRequest((value) => value + 1)
                  }}
                >
                  重新加载
                </button>
              </>
            ) : (
              <p role="status">
                <LoaderCircle className="spin" size={16} />
                正在读取记忆…
              </p>
            )}
          </div>
        )}
        {memories && matchingMemories && (
          <div className="memory-content">
            <form
              className="memory-form"
              aria-busy={busy && !removingID}
              onSubmit={(event) => {
                event.preventDefault()
                void save()
              }}
            >
              {fromChat && (
                <p className="memory-draft-source" id="memory-draft-source">
                  已填入选中的聊天消息。确认或修改后保存。
                </p>
              )}
              <label className="form-field">
                {editing ? '编辑记忆' : '添加记忆'}
                <textarea
                  ref={input}
                  rows={5}
                  maxLength={fromChat ? undefined : maxLength * 2}
                  placeholder="例如，我更喜欢简短的回答。"
                  aria-describedby={
                    fromChat ? 'memory-draft-source memory-length' : 'memory-length'
                  }
                  aria-invalid={length > maxLength}
                  disabled={busy}
                  value={draft}
                  onChange={(event) => {
                    const content = event.target.value
                    if (editing) setEditing({ ...editing, content })
                    else setNewDraft({ ...newDraft, content })
                  }}
                />
              </label>
              <div className="memory-actions">
                <small id="memory-length" className={length > maxLength ? 'memory-limit' : 'muted'}>
                  {length} / {maxLength} 字符{length > maxLength ? '，请缩短内容' : ''}
                </small>
                {editing && (
                  <button
                    type="button"
                    className="button ghost"
                    disabled={busy}
                    onClick={() => setEditing(null)}
                  >
                    取消编辑
                  </button>
                )}
                <button
                  type="submit"
                  className="button primary"
                  disabled={busy || Boolean(removingID) || !length || length > maxLength}
                >
                  {busy && !removingID ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    !editing && <Plus size={15} />
                  )}
                  {editing ? '保存修改' : '添加记忆'}
                </button>
              </div>
              <p className="memory-status" role="status">
                {status}
              </p>
            </form>
            <section className="memory-library" aria-labelledby="memory-library-title">
              <div className="memory-library-heading">
                <h3 id="memory-library-title">已保存</h3>
                <span>
                  {query ? `${matchingMemories.length} / ${memories.length}` : memories.length} 条
                </span>
              </div>
              {memories.length > 3 || search ? (
                <label className="memory-search">
                  <Search size={15} aria-hidden="true" />
                  <input
                    type="search"
                    aria-label="搜索记忆"
                    placeholder="搜索记忆"
                    value={search}
                    disabled={Boolean(removingID)}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
              ) : null}
              {matchingMemories.length ? (
                <ul className="memory-list" aria-label="已保存的记忆">
                  {matchingMemories.map((memory) => (
                    <li
                      className={editing?.id === memory.id ? 'editing' : undefined}
                      key={memory.id}
                    >
                      <div className="memory-item-content">
                        <p id={`memory-${memory.id}`}>{memory.content}</p>
                        <time dateTime={memory.updated_at} title="最后更新日期">
                          {shortDate(memory.updated_at)}
                        </time>
                      </div>
                      {removingID === memory.id ? (
                        <div className="memory-confirm">
                          <span>删除这条记忆？</span>
                          <button
                            type="button"
                            className="button ghost"
                            autoFocus
                            disabled={busy}
                            onClick={() => setRemovingID('')}
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            className="button danger"
                            disabled={busy}
                            onClick={() => void remove(memory.id)}
                          >
                            {busy ? '删除中…' : '删除'}
                          </button>
                        </div>
                      ) : (
                        <div className="memory-item-actions">
                          <button
                            type="button"
                            className="icon-button"
                            title="编辑这条记忆"
                            aria-label="编辑这条记忆"
                            aria-describedby={`memory-${memory.id}`}
                            disabled={busy || Boolean(removingID)}
                            onClick={() => edit(memory)}
                          >
                            <Pencil size={16} />
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            title="删除这条记忆"
                            aria-label="删除这条记忆"
                            aria-describedby={`memory-${memory.id}`}
                            disabled={busy || Boolean(removingID)}
                            onClick={() => {
                              setRemovingID(memory.id)
                              setError('')
                              setStatus('')
                            }}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="memory-empty">
                  {query ? '未找到匹配的记忆。' : '还没有保存的记忆。'}
                </p>
              )}
            </section>
            {error && (
              <p className="memory-error" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
