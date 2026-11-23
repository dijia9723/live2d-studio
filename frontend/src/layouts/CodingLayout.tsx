import { useState } from 'react'
import { ArrowLeft, Code2 } from 'lucide-react'
import { Link, Outlet, useMatch } from 'react-router-dom'
import { api } from '../api/client'
import { notify } from '../store/studio'
import '../assets/coding.css'

export default function CodingLayout({ desktopWindow }: { desktopWindow: boolean }) {
  const [returning, setReturning] = useState(false)
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
