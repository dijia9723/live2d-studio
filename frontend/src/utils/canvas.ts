/** 文件职责：计数推导、画布边界约束和 HTML 模板的数据绑定。 */
import type { CanvasBinding, CanvasCounter, CanvasRect } from '../types/canvas'

export const maxCanvasWidgets = 50
export const maxCanvasCounters = 50
export const maxWidgetHTML = 50000
export const bindingAliasPattern = /^[A-Za-z][A-Za-z0-9_]{0,31}$/
const limit = 1e12
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 })

/** 将输入限制为有限数字，避免无效输入污染持久化数据。 */
export function finiteNumber(value: number, fallback = 0) {
  return Number.isFinite(value) ? Math.max(-limit, Math.min(limit, value)) : fallback
}

/** 自动计数按时间戳推导，后台节流、刷新和重新进入页面不会丢失经过的周期。 */
export function counterValue(counter: CanvasCounter, now = Date.now()) {
  const periods =
    counter.mode === 'auto' && counter.running
      ? Math.floor(Math.max(0, now - counter.startedAt) / (counter.intervalSeconds * 1000))
      : 0
  return Math.round(finiteNumber(counter.value + periods * counter.step) * 1e6) / 1e6
}

/** 统一计数的展示格式；模板也可以通过 .raw 取得不含千分位的值。 */
export function formatCounter(value: number) {
  return numberFormat.format(value)
}

/** 百分比坐标适配不同画布尺寸，并保证元素完整留在画布内。 */
export function clampCanvasRect(rect: CanvasRect): CanvasRect {
  const width = Math.max(8, Math.min(100, finiteNumber(rect.width, 40)))
  const height = Math.max(5, Math.min(100, finiteNumber(rect.height, 16)))
  return {
    width,
    height,
    x: Math.max(0, Math.min(100 - width, finiteNumber(rect.x))),
    y: Math.max(0, Math.min(100 - height, finiteNumber(rect.y))),
  }
}

/** 收集模板变量名，用于提示遗漏的计数绑定。 */
export function templateAliases(html: string) {
  return [
    ...new Set(
      [...html.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)(?:\.(?:label|raw))?\s*\}\}/g)].map(
        (match) => match[1],
      ),
    ),
  ]
}

/** 替换文本或属性中的变量；调用方通过 DOM 文本赋值，计数名称不会被解析成 HTML。 */
export function bindCanvasText(
  template: string,
  bindings: CanvasBinding[],
  counters: CanvasCounter[],
  now: number,
) {
  return template.replace(
    /\{\{\s*([A-Za-z][A-Za-z0-9_]*)(?:\.(label|raw))?\s*\}\}/g,
    (_, alias: string, field?: string) => {
      const binding = bindings.find((item) => item.alias === alias)
      const counter = counters.find((item) => item.id === binding?.counterID)
      if (!counter) return '—'
      if (field === 'label') return counter.name
      const value = counterValue(counter, now)
      return field === 'raw' ? String(value) : formatCounter(value)
    },
  )
}

/**
 * HTML 只承载样式和展示，放在禁止脚本的独立 iframe 中。
 * 移除导航和嵌套文档，防止模板跳转；CSP 同时禁止脚本、表单和网络请求接口。
 */
export function widgetDocument(html: string) {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  parsed
    .querySelectorAll('script, iframe, frame, frameset, object, embed, base, link, meta, form')
    .forEach((element) => element.remove())
  parsed.querySelectorAll('*').forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (
        /^on/i.test(attribute.name) ||
        ['href', 'srcdoc', 'action', 'formaction', 'target', 'autofocus'].includes(attribute.name)
      ) {
        element.removeAttribute(attribute.name)
      }
    }
  })
  const policy =
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob: https: http:; font-src data: https:; base-uri 'none'; form-action 'none'"
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}*{box-sizing:border-box}body{font-family:system-ui,'Microsoft YaHei',sans-serif;color:#fff}img{max-width:100%}</style>${parsed.head.innerHTML}</head><body>${parsed.body.innerHTML}</body></html>`
}

export const defaultCounterHTML = `<style>
.card { height:100%; padding:18px 24px; border-radius:18px; background:linear-gradient(120deg,#7253adf0,#a16eabeb); color:white; display:flex; align-items:center; justify-content:space-between; gap:16px; box-shadow:0 8px 28px #38245322; }
.label { font-size:14px; opacity:.85; }
.value { font-size:clamp(24px,6vw,48px); font-weight:750; font-variant-numeric:tabular-nums; }
.dot { display:inline-block; width:7px; height:7px; margin-right:7px; border-radius:50%; background:#d7ffc6; animation:pulse 2s infinite; }
@keyframes pulse { 50% { opacity:.35; } }
</style>
<div class="card"><div class="label"><span class="dot"></span>{{count.label}}</div><strong class="value">{{count}}</strong></div>`

export const doubleCounterHTML = `<style>
.stats { display:flex; gap:12px; height:100%; color:white; }
.stat { flex:1; min-width:0; padding:16px 20px; border:1px solid #ffffff40; border-radius:16px; background:#302344dd; display:flex; flex-direction:column; justify-content:center; gap:6px; }
small { font-size:13px; opacity:.7; } strong { font-size:clamp(22px,5vw,40px); font-variant-numeric:tabular-nums; }
</style>
<div class="stats"><div class="stat"><small>{{count.label}}</small><strong>{{count}}</strong></div><div class="stat"><small>{{second.label}}</small><strong>{{second}}</strong></div></div>`
