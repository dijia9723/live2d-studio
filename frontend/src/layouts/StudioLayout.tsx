/**
 * 文件职责：主应用外壳布局（侧边栏导航 + 对话记录 + 内容区 Outlet）。
 * 负责会话的新建/打开/重命名/删除、Toast 自动消失、移动端抽屉与帮助弹窗。
 */
import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  AudioLines,
  ArrowUpRight,
  CircleHelp,
  Flower2,
  History,
  LayoutGrid,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Settings2,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { api } from '../api/client'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog'
import { emptyDraft, updateDraft } from '../store/chatDrafts'
import { notify, useStudio } from '../store/studio'
import type { Conversation } from '../types/api'
import { shortDate } from '../utils/format'

const navigation = [
  { path: '/', label: '工作台', Icon: LayoutGrid },
  { path: '/characters', label: '角色', Icon: Users },
  { path: '/settings', label: '设置', Icon: Settings2 },
]

type HistoryAction = { kind: 'help' } | { kind: 'rename' | 'delete'; conversation: Conversation }

export default function StudioLayout() {
  const conversations = useStudio((s) => s.conversations)
  const conversationID = useStudio((s) => s.conversationID)
  const characters = useStudio((s) => s.characters)
  const busy = useStudio((s) => s.busy)
  const notice = useStudio((s) => s.notice)
  const navigate = useNavigate()
  const historyDrawer = useRef<HTMLDialogElement>(null)
  const [search, setSearch] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [action, setAction] = useState<HistoryAction | null>(null)
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState('')
  const trimmedTitle = title.trim()
  const titleValid = trimmedTitle.length > 0 && Array.from(trimmedTitle).length <= 100

  // Toast 显示 5 秒后自动清除。
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => notify(''), 5000)
    return () => clearTimeout(timer)
  }, [notice])

  // 视口变宽到桌面尺寸时自动关闭移动端抽屉。
  useEffect(() => {
    const compact = window.matchMedia('(max-width: 960px)')
    const closeDrawerOnDesktop = () => {
      if (!compact.matches) historyDrawer.current?.close()
    }
    compact.addEventListener('change', closeDrawerOnDesktop)
    return () => compact.removeEventListener('change', closeDrawerOnDesktop)
  }, [])

  // 开始新对话：清空当前角色会话并回到工作台。
  const start = () => {
    const studio = useStudio.getState()
    if (studio.busy) return
    setHistoryError('')
    studio.selectCharacter(studio.characterID)
    historyDrawer.current?.close()
    navigate('/')
  }
  const open = async (conversation: Conversation) => {
    try {
      if (useStudio.getState().busy) return
      setHistoryError('')
      await useStudio.getState().openConversation(conversation)
      historyDrawer.current?.close()
      navigate('/')
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '无法打开对话')
    }
  }
  // 确认弹窗提交：删除或重命名，并在成功后同步本地列表。
  const updateConversation = async () => {
    if (!action || action.kind === 'help' || saving || (action.kind === 'rename' && !titleValid))
      return
    const { id } = action.conversation
    setSaving(true)
    setActionError('')
    try {
      if (action.kind === 'delete') {
        await api.deleteConversation(id)
        const studio = useStudio.getState()
        if (studio.conversationID === id) studio.selectCharacter(studio.characterID)
        useStudio.setState((state) => ({
          conversations: state.conversations.filter((item) => item.id !== id),
        }))
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

  const names = new Map(characters.map((character) => [character.id, character.name]))
  const query = search.trim().toLowerCase()
  const filtered = conversations.filter((item) =>
    [item.title, names.get(item.character_id)].some((value) =>
      value?.toLowerCase().includes(query),
    ),
  )
  const history = (
    <>
      <button className="new-chat" onClick={start} disabled={busy}>
        <Plus size={18} /> 新对话
      </button>
      <label className="history-search">
        <Search size={16} aria-hidden="true" />
        <input
          type="search"
          aria-label="搜索对话"
          placeholder="搜索标题或角色"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      {historyError && (
        <p className="history-error" role="alert">
          {historyError}
        </p>
      )}
      {filtered.length > 0 ? (
        <ul className="history-list" aria-label="已保存的对话">
          {filtered.map((item) => (
            <li className="history-entry" key={item.id}>
              <button
                className="history-select"
                aria-current={item.id === conversationID ? 'true' : undefined}
                disabled={busy}
                onClick={() => void open(item)}
              >
                <MessageSquare size={15} aria-hidden="true" />
                <span>
                  <strong title={item.title}>{item.title}</strong>
                  <small>
                    {[names.get(item.character_id), shortDate(item.updated_at)]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                </span>
              </button>
              <button
                className="history-action"
                aria-label={`重命名 ${item.title}`}
                title="重命名对话"
                onClick={() => {
                  setTitle(item.title)
                  setAction({ kind: 'rename', conversation: item })
                }}
              >
                <Pencil size={14} />
              </button>
              <button
                className="history-action"
                aria-label={`删除 ${item.title}`}
                title="删除对话"
                disabled={busy}
                onClick={() => setAction({ kind: 'delete', conversation: item })}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="history-placeholder">
          {conversations.length ? '没有匹配的对话' : '还没有对话记录'}
        </p>
      )}
    </>
  )

  return (
    <div className="app-shell">
      <aside className="app-sidebar" aria-label="工作台导航">
        <NavLink to="/" className="app-brand" aria-label="Live2D Studio 首页">
          <span className="app-brand-icon">
            <Flower2 size={24} strokeWidth={1.8} />
          </span>
          <span className="app-brand-name">
            Live2D <strong>Studio</strong>
          </span>
        </NavLink>
        <nav className="shell-nav" aria-label="主导航">
          {navigation.map(({ path, label, Icon }) => (
            <NavLink key={path} to={path} end={path === '/'} className="shell-nav-link">
              <Icon size={17} /> <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <button
          className="drawer-open"
          aria-label="打开对话记录"
          onClick={() => historyDrawer.current?.showModal()}
        >
          <History size={21} />
        </button>
        <section className="sidebar-history" aria-label="对话记录">
          <h2>对话记录</h2>
          {history}
        </section>
        <button className="shell-help" onClick={() => setAction({ kind: 'help' })}>
          <CircleHelp size={17} /> 帮助与关于
        </button>
      </aside>

      <main className="workspace">
        <Outlet />
      </main>

      <dialog className="history-drawer" ref={historyDrawer} aria-labelledby="history-drawer-title">
        <div className="history-drawer-header">
          <h2 id="history-drawer-title">对话记录</h2>
          <button
            className="drawer-close"
            aria-label="关闭对话记录"
            onClick={() => historyDrawer.current?.close()}
          >
            <X size={20} />
          </button>
        </div>
        {history}
        <button className="shell-help" onClick={() => setAction({ kind: 'help' })}>
          <CircleHelp size={17} /> 帮助与关于
        </button>
      </dialog>

      <Dialog
        open={!!action}
        onOpenChange={(open) => {
          if (open) return
          setAction(null)
          setActionError('')
        }}
      >
        <DialogContent
          className="modal shell-dialog"
          showCloseButton={false}
          aria-labelledby="shell-dialog-title"
          onEscapeKeyDown={(event) => {
            if (saving) event.preventDefault()
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          {action && action.kind !== 'help' ? (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void updateConversation()
              }}
            >
              {action.kind === 'delete' ? (
                <>
                  <DialogTitle asChild>
                    <h2 id="shell-dialog-title">删除对话？</h2>
                  </DialogTitle>
                  <p>「{action.conversation.title}」及其中的消息将被删除。</p>
                </>
              ) : (
                <>
                  <DialogTitle asChild>
                    <h2 id="shell-dialog-title">重命名对话</h2>
                  </DialogTitle>
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
          ) : (
            <>
              <button
                className="modal-close icon-button"
                aria-label="关闭帮助"
                onClick={() => setAction(null)}
              >
                <X size={18} />
              </button>
              <DialogTitle asChild>
                <h2 id="shell-dialog-title">关于 Live2D Studio</h2>
              </DialogTitle>
              <p>在设置中连接 OpenAI 兼容模型服务，即可与角色对话。图片输入需要模型支持视觉。</p>
              <p>
                This content uses sample data owned and copyrighted by Live2D Inc. The sample data
                are utilized in accordance with terms and conditions set by Live2D Inc. This content
                itself is created at the author’s sole discretion.
              </p>
              <a
                className="text-link"
                href="/live2d-models/LICENSE-Live2D.md"
                target="_blank"
                rel="noreferrer"
              >
                Live2D 样本模型使用条款 <ArrowUpRight size={14} />
              </a>
            </>
          )}
        </DialogContent>
      </Dialog>

      {notice && (
        <div className="toast" role="status">
          <AudioLines size={18} />
          <span>{notice}</span>
          <button aria-label="关闭提示" onClick={() => notify('')}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  )
}
