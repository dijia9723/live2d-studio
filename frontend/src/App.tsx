/**
 * 文件职责：应用根组件。
 * 初始化全局状态并加载对应窗口的界面。
 */
import { useEffect } from 'react'
import { Flower2, LoaderCircle, RefreshCw } from 'lucide-react'
import Router from './router'
import PetPage from './pages/PetPage'
import StudioNotice from './components/StudioNotice'
import { useStudio } from './store/studio'

export default function App({ mode }: { mode: 'studio' | 'pet' | 'coding' }) {
  const s = useStudio()
  useEffect(() => {
    void s.initialize()
    // 仅依赖 initialize 的稳定引用，避免状态变化导致重复初始化。
  }, [s.initialize])
  if (!s.ready)
    return (
      <div className="boot-screen">
        <Flower2 size={48} />
        <h1>Live2D Studio</h1>
        {s.loadError ? (
          <>
            <p>{s.loadError}</p>
            <button className="button primary" onClick={() => void s.initialize()}>
              <RefreshCw size={16} />
              重新连接
            </button>
          </>
        ) : (
          <>
            <LoaderCircle className="spin" size={21} />
            <p role="status">正在连接本地服务…</p>
          </>
        )}
      </div>
    )
  if (mode === 'pet') return <PetPage />
  return (
    <>
      <Router codingWindow={mode === 'coding'} desktop={s.desktop} />
      <StudioNotice />
    </>
  )
}
