import { useEffect, useRef, useState } from 'react'
import { Camera, ListTree, ScanLine, Square } from 'lucide-react'
import { baseURL, http } from '../../api/client'
import '../../assets/coding-browser-debug.css'

interface BrowserNode {
  role: string
  label?: string
  depth: number
}

const endpoint = '/coding/browser-debug'
const route = (id: string) => `${endpoint}/${encodeURIComponent(id)}`

function stopDetached(id: string) {
  return fetch(`${baseURL}${route(id)}`, {
    method: 'DELETE',
    headers: { 'X-Studio-Client': '1' },
    keepalive: true,
  })
}

export default function CodingBrowserDebug({
  visible = true,
  initialURL = '',
}: {
  visible?: boolean
  initialURL?: string
}) {
  const alive = useRef(true)
  const owned = useRef('')
  const [id, setID] = useState('')
  const [address, setAddress] = useState('')
  const [page, setPage] = useState('')
  const [tree, setTree] = useState<BrowserNode[]>()
  const [snapshot, setSnapshot] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (owned.current) void stopDetached(owned.current).catch(() => {})
    }
  }, [])

  const task = async (work: () => Promise<void>) => {
    if (busy) return
    setError('')
    setBusy(true)
    try {
      await work()
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : '浏览器调试操作失败')
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  const start = () =>
    task(async () => {
      const response = await http.post<{ data: { id: string } }>(endpoint, {})
      const next = response.data.data.id
      if (!alive.current) {
        void stopDetached(next).catch(() => {})
        return
      }
      owned.current = next
      setID(next)
      setAddress(initialURL)
    })

  const navigate = () =>
    task(async () => {
      const target = address.trim()
      if (!target) return
      const url = /^[a-z][a-z\d+.-]*:\/\//i.test(target) ? target : `https://${target}`
      const response = await http.post<{ data: { url: string } }>(`${route(id)}/navigate`, { url })
      setPage(response.data.data.url)
      setTree(undefined)
      setSnapshot('')
    })

  const inspect = () =>
    task(async () => {
      const response = await http.get<{ data: { nodes: BrowserNode[] } }>(`${route(id)}/tree`)
      setTree(response.data.data.nodes)
      setSnapshot('')
    })

  const capture = () =>
    task(async () => {
      const response = await http.get<{ data: { png: string } }>(`${route(id)}/screenshot`)
      setSnapshot(response.data.data.png)
      setTree(undefined)
    })

  const stop = () =>
    task(async () => {
      try {
        await http.delete(route(id))
      } finally {
        owned.current = ''
        setID('')
        setPage('')
        setTree(undefined)
        setSnapshot('')
      }
    })

  return (
    <details className="coding-browser-debug" hidden={!visible}>
      <summary>
        <ScanLine size={14} />
        隔离浏览器调试
      </summary>
      {!id ? (
        <>
          <p className="coding-muted">启动独立 Edge 或 Chromium，检查页面结构与截图。</p>
          <button
            className="coding-button"
            type="button"
            disabled={busy}
            onClick={() => void start()}
          >
            启动调试
          </button>
        </>
      ) : (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void navigate()
            }}
          >
            <input
              aria-label="调试地址"
              placeholder="http://localhost:3000"
              value={address}
              disabled={busy}
              onChange={(event) => setAddress(event.target.value)}
              maxLength={4096}
            />
            <button className="coding-button" disabled={busy || !address.trim()}>
              打开地址
            </button>
          </form>
          <div className="coding-actions">
            <button
              className="coding-button"
              type="button"
              disabled={busy || !page}
              onClick={() => void inspect()}
            >
              <ListTree size={14} />
              页面结构
            </button>
            <button
              className="coding-button"
              type="button"
              disabled={busy || !page}
              onClick={() => void capture()}
            >
              <Camera size={14} />
              截图
            </button>
            <button
              className="coding-button"
              type="button"
              disabled={busy}
              onClick={() => void stop()}
            >
              <Square size={14} />
              结束调试
            </button>
          </div>
          {page && (
            <p className="coding-muted" role="status">
              调试地址：{page}
            </p>
          )}
        </>
      )}
      {error && (
        <p className="coding-alert" role="alert">
          {error}
        </p>
      )}
      {tree && (
        <ol className="coding-debug-tree" aria-label="浏览器页面结构">
          {tree.map((node, index) => (
            <li key={index} style={{ paddingInlineStart: Math.min(node.depth, 8) * 6 }}>
              <code>{node.role}</code>
              {node.label && <span>{node.label}</span>}
            </li>
          ))}
          {tree.length === 0 && <li>此页没有可供检查的结构。</li>}
        </ol>
      )}
      {snapshot && (
        <img
          className="coding-debug-screenshot"
          src={`data:image/png;base64,${snapshot}`}
          alt="调试浏览器页面截图"
        />
      )}
    </details>
  )
}
