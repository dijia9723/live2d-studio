export function shortDate(value: string) {
  const d = new Date(value)
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}
export function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
