export interface ScreenRect {
  x: number
  y: number
  w: number
  h: number
}

export interface ScreenPoint {
  x: number
  y: number
}

export interface ScreenLine {
  text: string
  bounds: ScreenRect
}

export const fullScreen: ScreenRect = { x: 0, y: 0, w: 1, h: 1 }
const columns = 64
const rows = 40

export function screenSampler() {
  const preview = document.createElement('canvas')
  preview.width = columns
  preview.height = rows
  const context = preview.getContext('2d', { willReadFrequently: true })!
  return (frame: HTMLCanvasElement) => {
    context.drawImage(frame, 0, 0, columns, rows)
    return context.getImageData(0, 0, columns, rows).data
  }
}

export function changedScreenArea(
  previous: Uint8ClampedArray | undefined,
  next: Uint8ClampedArray,
) {
  if (!previous) return fullScreen
  let left = columns
  let right = -1
  let top = rows
  let bottom = -1
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const at = (y * columns + x) * 4
      const difference =
        Math.abs(next[at] - previous[at]) +
        Math.abs(next[at + 1] - previous[at + 1]) +
        Math.abs(next[at + 2] - previous[at + 2])
      if (difference < 28) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < 0) return null
  const x = Math.max(0, left - 3) / columns
  const y = Math.max(0, top - 3) / rows
  const w = Math.min(columns, right + 4) / columns - x
  const h = Math.min(rows, bottom + 4) / rows - y
  return w * h > 0.7 ? fullScreen : { x, y, w, h }
}

export function cropScreen(frame: HTMLCanvasElement, area: ScreenRect, maxSide: number) {
  const result = document.createElement('canvas')
  const width = Math.max(1, Math.round(frame.width * area.w))
  const height = Math.max(1, Math.round(frame.height * area.h))
  const scale = Math.min(1, maxSide / Math.max(width, height))
  result.width = Math.max(1, Math.round(width * scale))
  result.height = Math.max(1, Math.round(height * scale))
  result
    .getContext('2d')!
    .drawImage(
      frame,
      area.x * frame.width,
      area.y * frame.height,
      width,
      height,
      0,
      0,
      result.width,
      result.height,
    )
  return result
}

export function focusArea(point: ScreenPoint | undefined, lastChange: ScreenRect | undefined) {
  if (!point) return lastChange || fullScreen
  const w = 0.55
  const h = 0.55
  const x = Math.max(0, Math.min(1 - w, point.x - w / 2))
  const y = Math.max(0, Math.min(1 - h, point.y - h / 2))
  return { x, y, w, h }
}

export function mergeScreenLines(previous: ScreenLine[], lines: ScreenLine[], area: ScreenRect) {
  const outside = previous.filter(({ bounds }) => {
    const x = bounds.x + bounds.w / 2
    const y = bounds.y + bounds.h / 2
    return x < area.x || x > area.x + area.w || y < area.y || y > area.y + area.h
  })
  return [...outside, ...lines]
    .sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x)
    .slice(0, 250)
}

export function describeScreenChange(previous: ScreenLine[], current: ScreenLine[]) {
  const before = new Set(previous.map(({ text }) => text))
  const after = new Set(current.map(({ text }) => text))
  const added = [...after].filter((text) => !before.has(text)).slice(0, 6)
  const removed = [...before].filter((text) => !after.has(text)).slice(0, 4)
  if (!added.length && !removed.length) return ''
  const error = added.find((text) =>
    /错误|失败|异常|拒绝|\berror\b|\bfailed\b|exception/i.test(text),
  )
  return [
    error && `出现错误提示「${error}」`,
    added.length && `新增「${added.join(' / ')}」`,
    removed.length && `消失「${removed.join(' / ')}」`,
  ]
    .filter(Boolean)
    .join('；')
    .slice(0, 340)
}

export const screenQuestion =
  /刚才|现在|发生|这里|那里|这个|这些|哪个|哪里|那行|上面|下面|看下|看看|什么意思|屏幕|页面|窗口|按钮|报错|错误|点哪|图表|颜色|图标|布局|画面|截图|进度|screen|window|page|here|this|error/i
export const visualQuestion =
  /图表|图标|颜色|图片|布局|长什么样|画面|截图|看起来|chart|icon|colou?r|image|layout/i

export function describeScreen(
  lines: ScreenLine[],
  changes: string[],
  question: string,
  point?: ScreenPoint,
) {
  const terms = question.toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2}/gu) ?? []
  const found = new Set<string>()
  const ranked = lines
    .map((line) => {
      const text = line.text.toLowerCase()
      const match = terms.filter((term) => text.includes(term)).length
      const distance = point ? Math.hypot(point.x - line.bounds.x, point.y - line.bounds.y) : 0
      return { line, weight: match * 3 - distance }
    })
    .sort((a, b) => b.weight - a.weight)
  const relevant = ranked
    .flatMap(({ line }) => {
      if (found.has(line.text)) return []
      found.add(line.text)
      return [line.text]
    })
    .slice(0, 16)
  return [
    relevant.length ? `当前可见文字：${relevant.join(' / ')}` : '当前没有识别到可用文字。',
    changes.length && `近期变化（最近在前）：${changes.slice(0, 3).join(' | ')}`,
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1600)
}
