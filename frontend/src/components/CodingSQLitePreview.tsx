import { useEffect, useState } from 'react'
import { codingAPI, type CodingSQLitePage } from '../api/coding'

export default function CodingSQLitePreview({ project, path }: { project: string; path: string }) {
  const [table, setTable] = useState('')
  const [page, setPage] = useState(1)
  const [preview, setPreview] = useState<CodingSQLitePage>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    codingAPI
      .sqlite(project, path, table, page, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setPreview(value)
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [project, path, table, page])

  if (!preview)
    return (
      <p className={error ? 'coding-alert' : 'coding-muted'} role={error ? 'alert' : 'status'}>
        {error || '正在打开 SQLite 只读预览…'}
      </p>
    )

  return (
    <section className="coding-table-preview" aria-label="SQLite 只读预览">
      {error && (
        <p className="coding-alert" role="alert">
          {error}
        </p>
      )}
      {preview.stale_wal && (
        <p className="coding-muted">当前预览来自数据库文件，未包含 WAL 中尚未写回的数据。</p>
      )}
      {preview.tables_truncated && <p className="coding-muted">已达到可显示的表数量上限。</p>}
      {!preview.tables.length && <p className="coding-muted">没有可预览的数据表。</p>}
      {preview.tables.length > 0 && (
        <>
          <div className="coding-actions">
            <select
              aria-label="数据库表"
              value={table || preview.table}
              disabled={loading}
              onChange={(event) => {
                setTable(event.target.value)
                setPage(1)
              }}
            >
              {preview.tables.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="coding-button"
              disabled={loading || page === 1}
              onClick={() => setPage(page - 1)}
            >
              上一页
            </button>
            <button
              type="button"
              className="coding-button"
              disabled={loading || !preview.has_more}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </button>
          </div>
          <p className="coding-muted">
            第 {preview.page} 页{preview.columns_truncated && ' · 已隐藏多余列'}
          </p>
          <table>
            <thead>
              <tr>
                {preview.columns.map((column) => (
                  <th scope="col" key={column}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, column) => (
                    <td key={column}>{cell ?? <em>NULL</em>}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}
