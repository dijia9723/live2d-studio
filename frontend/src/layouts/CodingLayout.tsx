/**
 * CodingLayout 提供编码工作台窗口的外壳：顶部工具栏负责返回 Studio 工作台，
 * 主体通过 Outlet 渲染编码页、插件中心与增强设置等子路由。
 */
import { useState } from 'react'
import { ArrowLeft, Code2 } from 'lucide-react'
import { Link, Outlet, useMatch } from 'react-router-dom'
import { api } from '../api/client'
import { notify } from '../store/studio'
import '../assets/coding.css'

/**
 * CodingLayout 编码工作台布局。
 * desktopWindow 为 true 表示运行在桌面悬浮窗口中，此时需通过主进程接口关闭窗口；
 * 在普通浏览器路由下则退化为返回首页的链接。
 */
export default function CodingLayout({ desktopWindow }: { desktopWindow: boolean }) {
  const [returning, setReturning] = useState(false)
  // 仅在编码设置页显示「返回编码模式」，避免在其他子页出现误导性入口。
  const modelSettings = useMatch('/coding/settings')
  const returnToStudio = async () => {
    setReturning(true)
    try {
      await api.window('coding', false)
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '无法返回工作台')
    } finally {
      setReturning(false)
    }
  }

  return (
    <div className="coding-window">
      <header className="coding-window-toolbar">
        {desktopWindow ? (
          <button
            type="button"
            className="coding-button"
            disabled={returning}
            onClick={() => void returnToStudio()}
          >
            <ArrowLeft size={15} /> 返回工作台
          </button>
        ) : (
          <Link to="/" className="coding-button">
            <ArrowLeft size={15} /> 返回工作台
          </Link>
        )}
        {modelSettings && (
          <Link to="/coding" className="coding-button">
            <Code2 size={15} /> 返回编码模式
          </Link>
        )}
      </header>
      <main className="coding-window-content">
        <Outlet />
      </main>
    </div>
  )
}
