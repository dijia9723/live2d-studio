import { useEffect } from 'react'
import { Flower2, LoaderCircle, RefreshCw } from 'lucide-react'
import Router from './router'
import PetPage from './pages/PetPage'
import { useStudio } from './store/studio'

export default function App() {
  const s = useStudio()
  useEffect(() => {
    void s.initialize()
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
            <p>正在准备属于你们的空间…</p>
          </>
        )}
      </div>
    )
  if (new URLSearchParams(window.location.search).get('pet') === '1') return <PetPage />
  return <Router />
}
