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
  const error = added.find((text) => screenError.test(text))
  const other = added.filter((text) => text !== error)
  return [
    error && `出现错误提示「${error}」`,
    other.length && `新增「${other.join(' / ')}」`,
    removed.length && `消失「${removed.join(' / ')}」`,
  ]
    .filter(Boolean)
    .join('；')
    .slice(0, 340)
}

export const pointedQuestion = /这里|那里|这个|那个|我指|我点|鼠标|光标|\b(?:this|here|cursor)\b/i
const screenError =
  /错误|失败|异常|拒绝访问|报错|没有.{0,8}权限|权限不足|\berror\b|\bfailed\b|exception|access denied/i
const recentQuestion =
  /(?:刚才|之前|方才|最近).{0,18}(?:怎么了|发生|变[化了]|出现|消失|报错|提示|显示|哪[儿里]错|什么问题)|(?:什么|哪些|有啥).{0,6}变化|\b(?:what changed|what (?:just )?happened)\b/i
const explicitScreen =
  /屏幕|页面|窗口(?:里|上|中)|当前窗口|这个窗口|界面|画面|截图|这张图|图片|图标|图表|按钮|鼠标|光标|点哪|哪(?:一)?行|\b(?:screen|screenshot|on (?:this |the )?page|button|cursor|icon|chart)\b/i
const screenReference =
  /(?:这个|那个|这行|那行|这里|那里|上面|下面).{0,16}(?:什么意思|是什么|写(?:了|着)?什么|说(?:了|着)?什么|显示(?:了)?(?:什么|啥)|怎么了|报错|怎么[点弄用改修])|(?:看下|看看)(?:这里|这个)|\bwhat does this (?:say|mean)\b/i
const screenFollowUp =
  /^(?:那(?:么|我)?|所以|然后|接下来|这个)?[，,、 ]*(?:怎么办|怎么(?:处理|解决|修复|改|做|弄|排查)|如何(?:处理|解决|修复|排查)|为啥|为什么(?:会这样|报错|失败)?|原因是什么|下一步(?:做什么|怎么做)?|应该点哪个|现在好了(?:没有|吗)?|好了(?:没有|吗)?|还在(?:吗|么)?|还报错吗|重试吗)[？?。！! ]*$|^(?:so[, ]*)?(?:why|how (?:do i|can i) (?:fix|resolve) (?:it|this)|is it fixed(?: now)?)\s*[?.!]*$/i

export type ScreenQuestionIntent = 'current' | 'recent' | 'follow-up'

export function screenQuestionIntent(
  question: string,
  hasScreenTurn: boolean,
): ScreenQuestionIntent | undefined {
  const text = question.trim()
  if (recentQuestion.test(text)) return 'recent'
  if (hasScreenTurn && screenFollowUp.test(text)) return 'follow-up'
  if (
    explicitScreen.test(text) ||
    screenReference.test(text) ||
    /(?:报了什么错|哪(?:里|儿)报错|什么报错|报错了什么|什么错误码)|\bwhat (?:is|was) the error\b/i.test(
      text,
    )
  )
    return 'current'
}

export function needsScreenImage(question: string) {
  if (
    /颜色|配色|布局|图表|长什么样|发.{0,6}(?:图|截图)|\b(?:colou?r|layout|chart|show me (?:the|this) screenshot)\b/i.test(
      question,
    )
  ) {
    return true
  }
  // Questions about the text in a screenshot can usually use OCR alone.
  if (
    /(?:哪行|什么字|写了什么|写着什么|文字|错误码|报了什么错|报错内容|提示内容|读一下)|\b(?:read|text|error code)\b/i.test(
      question,
    )
  ) {
    return false
  }
  return /图标|这张图|图片|看起来|\bicon\b/i.test(question)
}

function questionTerms(question: string) {
  const words = question.toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu) ?? []
  return [
    ...new Set(
      words.flatMap((word) =>
        /^\p{Script=Han}/u.test(word)
          ? Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))
          : [word],
      ),
    ),
  ].slice(0, 32)
}

export function describeScreen(
  lines: ScreenLine[],
  changes: string[],
  question: string,
  point?: ScreenPoint,
) {
  const terms = questionTerms(question)
  const askingAboutError = screenError.test(question)
  const askingForLocation = /在哪|点哪|怎么点|哪个按钮|位置|\b(?:where|click)\b/i.test(question)
  const found = new Set<string>()
  const ranked = lines
    .map((line) => {
      const text = line.text.toLowerCase()
      const match = terms.filter((term) => text.includes(term)).length
      const { x, y, w, h } = line.bounds
      const distance = point
        ? Math.hypot(
            Math.max(x - point.x, 0, point.x - x - w),
            Math.max(y - point.y, 0, point.y - y - h),
          )
        : 0
      const error = askingAboutError && screenError.test(text) ? 3 : 0
      return { line, weight: match * 2 + error - distance * 3 }
    })
    .sort((a, b) => b.weight - a.weight)
  const relevant = ranked
    .flatMap(({ line }) => {
      if (found.has(line.text)) return []
      found.add(line.text)
      if (!askingForLocation) return [line.text]
      const horizontal = line.bounds.x + line.bounds.w / 2
      const vertical = line.bounds.y + line.bounds.h / 2
      const side = horizontal < 1 / 3 ? '左' : horizontal > 2 / 3 ? '右' : '中'
      const height = vertical < 1 / 3 ? '上' : vertical > 2 / 3 ? '下' : '部'
      return [`[${side}${height}]${line.text}`]
    })
    .slice(0, 16)
  const current = relevant.length
    ? `当前可见文字：${relevant.join(' / ').slice(0, 1050)}`
    : '当前没有识别到可用文字。'
  const recent =
    changes.length && `近期变化（最近在前）：${changes.slice(0, 3).join(' | ').slice(0, 500)}`
  return (
    recentQuestion.test(question) ||
    /刚才|变化|新增|消失|之前|\b(?:changed|previous|earlier)\b/i.test(question)
      ? [recent, current]
      : [current, recent]
  )
    .filter(Boolean)
    .join('\n')
}
