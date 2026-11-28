/**
 * CodingBrowserDebug 通过后端启动隔离的 Edge/Chromium 会话，提供地址导航、
 * 页面无障碍结构树查看与截图能力，用于调试本地 Web 项目。
 */
import { useEffect, useRef, useState } from 'react'
import { Camera, ListTree, ScanLine, Square } from 'lucide-react'
import { baseURL, http } from '../../api/client'
import '../../assets/coding-browser-debug.css'

/** BrowserNode 后端返回的页面结构节点，depth 用于缩进展示层级。 */
interface BrowserNode {
  role: string
  label?: string
  depth: number
}

const endpoint = '/coding/browser-debug'
const route = (id: string) => `${endpoint}/${encodeURIComponent(id)}`

/** stopDetached 在窗口卸载时用 keepalive 请求结束遗留的调试会话。 */
function stopDetached(id: string) {
  return fetch(`${baseURL}${route(id)}`, {
    method: 'DELETE',
    headers: { 'X-Studio-Client': '1' },
    keepalive: true,
  })
}

/** CodingBrowserDebug 隔离浏览器调试面板；visible 仅控制显示，不销毁调试会话。 */
export default function CodingBrowserDebug({
  visible = true,
  initialURL = '',
}: {
  /** 是否显示面板。 */
  visible?: boolean
  /** 启动调试时预填的地址。 */
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
      // 组件卸载时后端进程仍在运行，需要主动通知后端结束，避免遗留浏览器进程。
      alive.current = false
      if (owned.current) void stopDetached(owned.current).catch(() => {})
    }
  }, [])

  const task = async (work: () => Promise<void>) => {
    // 串行化操作：导航/截图/检查同时发起时后端状态会互相覆盖。
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
        // 启动请求返回前组件已卸载，立即回收刚创建的调试会话。
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
      // 页面已变化，旧的页面结构和截图失效，清空避免误导。
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
