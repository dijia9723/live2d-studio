import { useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw } from 'lucide-react'
import CodingBrowserDebug from './CodingBrowserDebug'

export default function CodingBrowserPanel() {
  const [address, setAddress] = useState('')
  const [pages, setPages] = useState<string[]>([])
  const [index, setIndex] = useState(-1)
  const [refresh, setRefresh] = useState(0)
  const [error, setError] = useState('')
  const [debug, setDebug] = useState(false)
  const [debugMounted, setDebugMounted] = useState(false)
  const current = pages[index]

  function navigate(next: number) {
    setIndex(next)
    setAddress(pages[next])
    setError('')
  }

  function open() {
    const text = address.trim()
    if (!text) return
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        throw new Error()
      }
      setAddress(url.href)
      setPages([...pages.slice(0, index + 1), url.href])
      setIndex(index + 1)
      setError('')
    } catch {
      setError('请输入有效的 HTTP 或 HTTPS 地址')
    }
  }

  return (
    <section className="coding-browser" aria-label="项目浏览器">
      <div className="coding-browser-toolbar" role="group" aria-label="浏览器模式">
        <button
          type="button"
          className="coding-button"
          aria-pressed={!debug}
          onClick={() => setDebug(false)}
        >
          网页预览
        </button>
        <button
          type="button"
          className="coding-button"
          aria-pressed={debug}
          onClick={() => {
            setDebugMounted(true)
            setDebug(true)
          }}
        >
          调试
        </button>
      </div>
      {debugMounted && (
        <div className="coding-browser-debug-host" hidden={!debug}>
          <CodingBrowserDebug visible={debug} />
        </div>
      )}
      <div className="coding-browser" hidden={debug}>
        <form
          className="coding-browser-address"
          onSubmit={(event) => {
            event.preventDefault()
            open()
          }}
        >
          <input
            aria-label="网页地址"
            placeholder="https://example.com"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
          <button className="coding-button" disabled={!address.trim()}>
            前往
          </button>
        </form>
        <div className="coding-browser-toolbar">
          <button
            type="button"
            className="coding-icon"
            aria-label="后退"
            disabled={index <= 0}
            onClick={() => navigate(index - 1)}
          >
            <ArrowLeft size={15} />
          </button>
          <button
            type="button"
            className="coding-icon"
            aria-label="前进"
            disabled={index >= pages.length - 1}
            onClick={() => navigate(index + 1)}
          >
            <ArrowRight size={15} />
          </button>
          <button
            type="button"
            className="coding-icon"
            aria-label="刷新网页"
            disabled={!current}
            onClick={() => setRefresh(refresh + 1)}
          >
            <RotateCw size={15} />
          </button>
          {current && (
            <a className="coding-button" href={current} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={14} />
              外部打开
            </a>
          )}
        </div>
        {error && (
          <p className="coding-alert" role="alert">
            {error}
          </p>
        )}
        {current ? (
          <>
            <iframe
              title="网页预览"
              key={`${index}-${refresh}`}
              src={current}
              sandbox="allow-scripts allow-forms"
              referrerPolicy="no-referrer"
            />
            <p className="coding-muted">网页禁止嵌入时，可选择「外部打开」。</p>
          </>
        ) : (
          <div className="coding-empty">
            <Globe size={25} />
            <h2>打开网页或本地开发服务</h2>
          </div>
        )}
      </div>
    </section>
  )
}
