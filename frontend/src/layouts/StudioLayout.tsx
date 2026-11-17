import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  AudioLines,
  BookOpen,
  ChevronRight,
  CircleHelp,
  Flower2,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { api } from '../api/client'
import { notify, useStudio } from '../store/studio'
import { shortDate } from '../utils/format'

export default function StudioLayout() {
  const s = useStudio()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [about, setAbout] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  useEffect(() => {
    if (!s.notice) return
    const t = setTimeout(() => s.patch({ notice: '' }), 5000)
    return () => clearTimeout(t)
  }, [s.notice, s.patch])
  const start = () => {
    if (s.busy) return
    s.selectCharacter(s.characterID)
    navigate('/')
  }
  const remove = async () => {
    if (!removing) return
    try {
      await api.deleteConversation(removing)
      if (s.conversationID === removing) s.selectCharacter(s.characterID)
      await s.refreshConversations()
      setRemoving(null)
    } catch (e) {
      notify(String(e))
    }
  }
  return (
    <div className="app-shell">
      <nav className="nav-rail" aria-label="主导航">
        <a className="brand-mark" href="#/" title="Live2D Studio">
          <Flower2 size={29} strokeWidth={1.7} />
        </a>
        <div className="rail-items">
          <NavLink to="/" end className={({ isActive }) => `rail-link ${isActive ? 'active' : ''}`}>
            <MessageCircle size={21} />
            <span>工作室</span>
          </NavLink>
          <NavLink
            to="/characters"
            className={({ isActive }) => `rail-link ${isActive ? 'active' : ''}`}
          >
            <Users size={21} />
            <span>角色</span>
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) => `rail-link ${isActive ? 'active' : ''}`}
          >
            <Settings2 size={21} />
            <span>设置</span>
          </NavLink>
        </div>
        <div className="rail-bottom">
          <button className="rail-link" onClick={() => setAbout(true)} title="关于与帮助">
            <CircleHelp size={21} />
            <span>帮助</span>
          </button>
          <div className="profile-icon">ME</div>
        </div>
      </nav>
      <aside className="history-sidebar">
        <div className="wordmark">
          Live2D<span>Studio</span>
          <span className="beta-badge">BETA</span>
        </div>
        <p className="sidebar-tagline">让每一次对话，都有温度。</p>
        <button className="new-chat" onClick={start} disabled={s.busy}>
          <Plus size={17} />
          开启新对话<span>＋</span>
        </button>
        <div className="history-heading">
          <span>对话记录</span>
          <span>{s.conversations.length}</span>
        </div>
        <label className="search-box">
          <Search size={15} />
          <input
            aria-label="搜索对话"
            placeholder="搜索你的回忆…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="conversation-list">
          {s.conversations
            .filter((c) => c.title.toLowerCase().includes(search.toLowerCase()))
            .map((c) => (
              <div
                className={`history-item ${s.conversationID === c.id ? 'selected' : ''}`}
                key={c.id}
              >
                <button
                  className="history-open"
                  disabled={s.busy}
                  onClick={() => {
                    void s
                      .openConversation(c)
                      .then(() => navigate('/'))
                      .catch((e) => notify(String(e)))
                  }}
                >
                  <MessageCircle size={15} />
                  <div>
                    <strong>{c.title}</strong>
                    <small>
                      {s.characters.find((ch) => ch.id === c.character_id)?.name} ·{' '}
                      {shortDate(c.updated_at)}
                    </small>
                  </div>
                </button>
                <button
                  className="history-delete icon-button"
                  aria-label={`删除 ${c.title}`}
                  disabled={s.busy}
                  onClick={() => setRemoving(c.id)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          {!s.conversations.length && (
            <div className="history-empty">
              <BookOpen size={25} />
              <p>故事从这里开始</p>
              <span>你的每一段对话，都会珍藏在这里。</span>
            </div>
          )}
          {!!s.conversations.length &&
            !s.conversations.some((c) => c.title.toLowerCase().includes(search.toLowerCase())) && (
              <p className="muted small">没有找到相关对话</p>
            )}
        </div>
        <button className="sidebar-tip" onClick={() => navigate('/settings')}>
          <span className="tip-icon">
            <Sparkles size={17} />
          </span>
          <div>
            <strong>连接你的 AI 灵感</strong>
            <small>配置模型，开启专属陪伴</small>
          </div>
          <ChevronRight size={15} />
        </button>
        <div className="sidebar-footer">
          <span className="status-dot" />
          本地服务已连接<span className="version">v0.1.0</span>
        </div>
      </aside>
      <main className="workspace">
        <Outlet />
      </main>
      {s.notice && (
        <div className="toast" role="status">
          <AudioLines size={18} />
          <span>{s.notice}</span>
          <button aria-label="关闭提示" onClick={() => s.patch({ notice: '' })}>
            <X size={15} />
          </button>
        </div>
      )}
      {removing && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-title">
            <span className="modal-icon">
              <Trash2 size={24} />
            </span>
            <h2 id="delete-title">删除这段对话？</h2>
            <p>对话中的消息会一并删除，此操作无法撤销。</p>
            <div className="modal-actions">
              <button className="button ghost" onClick={() => setRemoving(null)}>
                保留回忆
              </button>
              <button className="button danger" onClick={() => void remove()}>
                删除对话
              </button>
            </div>
          </div>
        </div>
      )}
      {about && (
        <div className="modal-backdrop">
          <div
            className="modal about-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="about-title"
          >
            <button
              className="modal-close icon-button"
              aria-label="关闭"
              onClick={() => setAbout(false)}
            >
              <X size={18} />
            </button>
            <Flower2 className="purple" size={40} />
            <h2 id="about-title">Live2D Studio</h2>
            <p>一个有表情、有声音的 AI 伙伴工作室。</p>
            <div className="about-facts">
              <span>桌面 · Wails 3</span>
              <span>服务 · Go / Gin</span>
              <span>智能体 · Eino</span>
            </div>
            <p className="small">
              在设置中连接 OpenAI
              兼容服务，即可开始对话。浏览器语音取决于系统支持，也可以接入兼容的语音识别与合成
              API。上传图片需要模型支持视觉。
            </p>
            <p className="small muted">
              灵感来自 Open-LLM-VTuber。This content uses sample data owned and copyrighted by
              Live2D Inc. The sample data are utilized in accordance with terms and conditions set
              by Live2D Inc. This content itself is created at the author’s sole discretion.
            </p>
            <a
              className="text-link"
              href="/live2d-models/LICENSE-Live2D.md"
              target="_blank"
              rel="noreferrer"
            >
              Live2D 样本模型使用条款 <MoreHorizontal size={14} />
            </a>
          </div>
        </div>
      )}
    </div>
  )
}
