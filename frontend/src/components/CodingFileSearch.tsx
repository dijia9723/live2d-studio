import { useEffect, useState } from 'react'
import { FileCode2, Search, X } from 'lucide-react'
import { codingAPI } from '../api/coding'

interface Props {
  project: string
  onChoose: (path: string) => void
  onClose: () => void
}

export default function CodingFileSearch({ project, onChoose, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ files: string[]; truncated: boolean }>()
  const [error, setError] = useState('')
  const term = query.trim()

  useEffect(() => {
    if (!term) return
    const controller = new AbortController()
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
