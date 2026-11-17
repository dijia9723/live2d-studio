/**
 * 文件职责：通用格式化与文件下载等轻量工具函数。
 */

/** 把 ISO 时间格式化为“月 日”形式的短日期。 */
export function shortDate(value: string) {
  const d = new Date(value)
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}
/** 以 Markdown 文本触发浏览器下载，并在稍后释放 Blob URL。 */
export function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
