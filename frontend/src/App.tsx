/**
 * 文件职责：应用根组件。
 * 负责启动时初始化全局状态、渲染启动/错误界面，并根据 ?pet=1 决定进入桌宠模式还是主应用路由。
 */
import { useEffect } from 'react'
import { Flower2, LoaderCircle, RefreshCw } from 'lucide-react'
import Router from './router'
import PetPage from './pages/PetPage'
import { useStudio } from './store/studio'

export default function App({ pet }: { pet: boolean }) {
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
  // 桌宠窗口通过查询参数区分，复用同一份全局状态。
  if (pet) return <PetPage />
  return <Router />
}
