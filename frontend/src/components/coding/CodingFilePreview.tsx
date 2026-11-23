/**
 * CodingFilePreview 提供编码面板中的富文件预览：按扩展名识别图片、音视频、PDF、
 * XLSX 工作簿，并把文本文件渲染为 Markdown、JSON 树或 CSV 表格。
 */
import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { codingAPI } from '../../api/coding'
import CodingWorkbookPreview from './CodingWorkbookPreview'

/** mediaPreviewKind 根据文件扩展名返回可用的预览种类，未知类型返回 undefined。 */
export function mediaPreviewKind(path: string) {
  const extension = /\.([^.\/]+)$/.exec(path)?.[1].toLowerCase()
  if (!extension) return undefined
  if (/^(png|jpe?g|gif|webp|avif)$/.test(extension)) return 'image'
  if (/^(mp3|wav|ogg|flac|m4a)$/.test(extension)) return 'audio'
  if (/^(mp4|webm)$/.test(extension)) return 'video'
  if (extension === 'pdf') return 'pdf'
  if (extension === 'xlsx' || extension === 'xlsm') return 'workbook'
  return undefined
}

/** CodingMediaPreview 懒加载二进制媒体并以 Blob URL 展示；工作簿交给专用预览组件。 */
export function CodingMediaPreview({ project, path }: { project: string; path: string }) {
  const [url, setURL] = useState('')
  const [workbook, setWorkbook] = useState<Blob>()
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let objectURL = ''
    codingAPI
      .media(project, path, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return
        if (mediaPreviewKind(path) === 'workbook') {
          setWorkbook(blob)
          return
        }
        // 用对象 URL 避免把大文件转成 base64 塞进 data URI。
        objectURL = URL.createObjectURL(blob)
        setURL(objectURL)
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message)
      })
    return () => {
      controller.abort()
      // 切换文件时必须释放对象 URL，否则 Blob 会一直驻留内存。
      if (objectURL) URL.revokeObjectURL(objectURL)
    }
  }, [project, path])
  if (error)
    return (
      <p className="coding-alert" role="alert">
        {error}
      </p>
    )
  if (workbook) return <CodingWorkbookPreview blob={workbook} />
  if (!url)
    return (
      <p className="coding-muted" role="status">
        正在载入预览…
      </p>
    )
  switch (mediaPreviewKind(path)) {
    case 'image':
      return <img src={url} alt={path} />
    case 'audio':
      return <audio src={url} controls aria-label={path} />
    case 'video':
      return <video src={url} controls aria-label={path} />
    case 'pdf':
      // PDF 预览禁用脚本，避免嵌入文档执行代码。
      return <iframe src={url} title={path} sandbox="" />
  }
}

/** csvRows 轻量解析 CSV/TSV（支持引号转义），并限制行列数量防止超大文件拖垮渲染。 */
function csvRows(text: string, separator: string) {
  const rows: string[][] = []
  let row: string[] = []
  let value = ''
  let quoted = false
  const endCell = () => {
    // 单行最多保留 60 列，多余列丢弃，避免宽表撑爆 DOM。
    if (row.length < 60) row.push(value)
    value = ''
  }
  // 最多解析 500 行，超出部分不再处理。
  for (let index = 0; index < text.length && rows.length < 500; index++) {
    const char = text[index]
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"'
        index++
      } else if (quoted || !value) {
        quoted = !quoted
      } else {
        value += char
      }
    } else if (!quoted && char === separator) {
      endCell()
    } else if (!quoted && (char === '\r' || char === '\n')) {
      if (char === '\r' && text[index + 1] === '\n') index++
      endCell()
      rows.push(row)
      row = []
    } else {
      value += char
    }
  }
  if (rows.length < 500 && (row.length || value)) {
    endCell()
    rows.push(row)
  }
  return rows
}

/** JsonNode 递归渲染 JSON：限制深度与每层条目数，避免超大文档造成卡顿。 */
function JsonNode({ value, label, depth = 0 }: { value: unknown; label: string; depth?: number }) {
  if (value === null || typeof value !== 'object') {
    return (
      <div>
        {label}: {JSON.stringify(value)}
      </div>
    )
  }
  if (depth >= 8) return <div>{label}: …</div>
  const entries = Object.entries(value)
  return (
    <details open={depth < 2}>
      <summary>
        {label} ({entries.length})
      </summary>
      {entries.slice(0, 100).map(([key, child]) => (
        <JsonNode key={key} label={key} value={child} depth={depth + 1} />
      ))}
      {entries.length > 100 && <div>…</div>}
    </details>
  )
}

/** CodingTextPreview 按扩展名把文本渲染为 JSON 树、CSV 表格或只读 Markdown。 */
export function CodingTextPreview({ path, text }: { path: string; text: string }) {
  const kind = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  // CSV 解析较重，只在内容变化时重新计算。
  const rows = useMemo(
    () => (kind === 'csv' || kind === 'tsv' ? csvRows(text, kind === 'tsv' ? '\t' : ',') : []),
    [kind, text],
  )
  if (kind === 'json') {
    try {
      return (
        <div className="coding-json-preview">
          <JsonNode label="JSON" value={JSON.parse(text)} />
        </div>
      )
    } catch {
      return (
        <p className="coding-alert" role="alert">
          目前的文件内容不是有效的 JSON。
        </p>
      )
    }
  }
  if (kind === 'csv' || kind === 'tsv') {
    const [header, ...body] = rows
    return (
      <div className="coding-table-preview">
        <table>
          {header && (
            <thead>
              <tr>
                {header.map((cell, index) => (
                  <th key={index} scope="col">
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {body.map((row, index) => (
              <tr key={index}>
                {row.map((cell, column) => (
                  <td key={column}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="coding-muted">{rows.length} 行 · 预览最多显示 500 行、60 列</p>
      </div>
    )
  }
  return (
    <div className="coding-message coding-markdown-preview" aria-label="Markdown 预览">
      {/* 禁用图片与链接，避免预览不可信文件时发起外部请求。 */}
      <ReactMarkdown disallowedElements={['img', 'a']} unwrapDisallowed>
        {text}
      </ReactMarkdown>
    </div>
  )
}
