/**
 * CodingSQLitePreview 以只读方式分页展示项目内 SQLite 数据库的表数据，
 * 用于在不启动数据库客户端的情况下快速核对表内容。
 */
import { useEffect, useState } from 'react'
import { codingAPI, type CodingSQLitePage } from '../../api/coding'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'

/** CodingSQLitePreview SQLite 只读预览组件。 */
export default function CodingSQLitePreview({ project, path }: { project: string; path: string }) {
  const [table, setTable] = useState('')
  const [page, setPage] = useState(1)
  const [preview, setPreview] = useState<CodingSQLitePage>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    // 表或页码变化时重新请求；abort 防止旧响应覆盖新状态。
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
        // 只读预览直接读主库文件，WAL 中尚未 checkpoint 的数据不可见，需明确提示避免误判。
        <p className="coding-muted">当前预览来自数据库文件，未包含 WAL 中尚未写回的数据。</p>
      )}
      {preview.tables_truncated && <p className="coding-muted">已达到可显示的表数量上限。</p>}
      {!preview.tables.length && <p className="coding-muted">没有可预览的数据表。</p>}
      {preview.tables.length > 0 && (
        <>
          <div className="coding-actions">
            <Select
              value={table || preview.table}
              disabled={loading}
              onValueChange={(name) => {
                setTable(name)
                // 切换表后页码归零，避免沿用上一张表的页码导致越界。
                setPage(1)
              }}
            >
              <SelectTrigger aria-label="数据库表">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {preview.tables.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
