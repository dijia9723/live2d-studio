/**
 * 文件职责：主应用外壳布局，包含导航、内容区、帮助弹窗与全局提示。
 */
import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import {
  AudioLines,
  ArrowUpRight,
  CircleHelp,
  Code2,
  Flower2,
  LayoutGrid,
  Settings2,
  Users,
  X,
} from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog'
import { notify, useStudio } from '../store/studio'

const navigation = [
  { path: '/', label: '工作台', Icon: LayoutGrid },
  { path: '/coding', label: '编码模式', Icon: Code2 },
  { path: '/characters', label: '角色', Icon: Users },
  { path: '/settings', label: '设置', Icon: Settings2 },
]

export default function StudioLayout() {
  const notice = useStudio((s) => s.notice)
  const [helpOpen, setHelpOpen] = useState(false)

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => notify(''), 5000)
    return () => clearTimeout(timer)
  }, [notice])

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
          type="button"
          className="shell-help"
          aria-label="帮助与关于"
          title="帮助与关于"
          onClick={() => setHelpOpen(true)}
        >
          <CircleHelp size={17} aria-hidden="true" /> <span>帮助与关于</span>
        </button>
      </aside>

      <main className="workspace">
        <Outlet />
      </main>

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="modal shell-dialog" showCloseButton={false}>
          <button
            className="modal-close icon-button"
            aria-label="关闭帮助"
            onClick={() => setHelpOpen(false)}
          >
            <X size={18} />
          </button>
          <DialogTitle>关于 Live2D Studio</DialogTitle>
          <DialogDescription>
            在设置中连接 OpenAI 兼容模型服务，即可与角色对话。图片输入需要模型支持视觉。
          </DialogDescription>
          <p>
            This content uses sample data owned and copyrighted by Live2D Inc. The sample data are
            utilized in accordance with terms and conditions set by Live2D Inc. This content itself
            is created at the author’s sole discretion.
          </p>
          <a
            className="text-link"
            href="/live2d-models/LICENSE-Live2D.md"
            target="_blank"
            rel="noreferrer"
          >
            Live2D 样本模型使用条款 <ArrowUpRight size={14} />
          </a>
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
