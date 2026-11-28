/**
 * CodingFileSearch 提供项目内文件的快捷搜索浮层：输入关键字后做防抖查询，
 * 支持回车打开首个结果、Esc 关闭，用于文件面板和输入框的 @ 引用。
 */
import { useEffect, useState } from 'react'
import { FileCode2, Search, X } from 'lucide-react'
import { codingAPI } from '../../api/coding'

/** Props 文件搜索组件的入参。 */
interface Props {
  /** 目标编码项目 ID。 */
  project: string
  /** 选中某个文件路径时回调。 */
  onChoose: (path: string) => void
  /** 关闭搜索浮层。 */
  onClose: () => void
}

/** CodingFileSearch 项目文件搜索浮层。 */
export default function CodingFileSearch({ project, onChoose, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ files: string[]; truncated: boolean }>()
  const [error, setError] = useState('')
  const term = query.trim()

  useEffect(() => {
    if (!term) return
    const controller = new AbortController()
    // 180ms 防抖：避免逐字符触发后端文件扫描，同时用 AbortController 丢弃过期响应。
    const timer = window.setTimeout(() => {
      codingAPI
        .search(project, term, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setResult(value)
        })
        .catch((cause: Error) => {
          if (!controller.signal.aborted) setError(cause.message)
        })
    }, 180)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [project, term])

  return (
    <div
      className="coding-file-search"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div className="coding-search-input">
        <Search size={15} />
        <input
          autoFocus
          aria-label="搜索项目文件"
          placeholder="输入文件名或路径"
          maxLength={128}
          value={query}
          onChange={(event) => {
            const next = event.target.value
            if (next.trim() !== term) {
              setResult(undefined)
              setError('')
            }
            setQuery(next)
          }}
          onKeyDown={(event) => {
            // 回车直接采用第一个匹配项，契合快速跳转文件的使用习惯。
            if (event.key === 'Enter') {
              event.preventDefault()
              if (result?.files[0]) onChoose(result.files[0])
            }
          }}
        />
        <button type="button" className="coding-icon" onClick={onClose} aria-label="关闭文件搜索">
          <X size={15} />
        </button>
      </div>
      {error && (
        <p className="coding-alert" role="alert">
          {error}
        </p>
      )}
      {term && !result && !error && (
        <p className="coding-muted" role="status">
          正在搜索…
        </p>
      )}
      {result && (
        <div className="coding-file-list">
          {result.files.map((path) => (
            <button type="button" key={path} title={path} onClick={() => onChoose(path)}>
              <FileCode2 size={15} />
              <span>{path}</span>
            </button>
          ))}
          {result.files.length === 0 && <p className="coding-muted">没有匹配的文件</p>}
          {result.truncated && <p className="coding-muted">缩小搜索范围可查找更多匹配</p>}
        </div>
      )}
    </div>
  )
}
