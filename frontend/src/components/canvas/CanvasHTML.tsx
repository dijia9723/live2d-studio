/** 文件职责：隔离渲染自定义 HTML，通过 DOM 文本绑定更新计数，保留 CSS 动画。 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasCounter, CanvasWidget } from '../../types/canvas'
import { bindCanvasText, widgetDocument } from '../../utils/canvas'

interface TemplateTarget {
  node: Node
  attribute?: string
  template: string
}

/** 只在 HTML 改变时重建文档，计数变化直接更新对应节点，不刷新 iframe。 */
export default function CanvasHTML({
  widget,
  counters,
  now,
}: {
  widget: CanvasWidget
  counters: CanvasCounter[]
  now: number
}) {
  const iframe = useRef<HTMLIFrameElement>(null)
  const targets = useRef<TemplateTarget[]>([])
  const [failed, setFailed] = useState(false)
  const document = useMemo(() => widgetDocument(widget.html), [widget.html])
  const values = useRef({ bindings: widget.bindings, counters, now })
  values.current = { bindings: widget.bindings, counters, now }

  const refresh = () => {
    const { bindings, counters, now } = values.current
    for (const target of targets.current) {
      const value = bindCanvasText(target.template, bindings, counters, now)
      if (target.attribute && target.node.nodeType === Node.ELEMENT_NODE) {
        const element = target.node as Element
        if (element.getAttribute(target.attribute) !== value)
          element.setAttribute(target.attribute, value)
      } else if (target.node.nodeValue !== value) target.node.nodeValue = value
    }
  }
  useEffect(refresh, [widget.bindings, counters, now])

  return (
    <>
      <iframe
        ref={iframe}
        title={widget.name || '计数组件'}
        srcDoc={document}
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer"
        tabIndex={-1}
        onLoad={() => {
          targets.current = []
          const doc = iframe.current?.contentDocument
          if (!doc) {
            setFailed(true)
            return
          }
          setFailed(false)
          const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_TEXT)
          while (walker.nextNode()) {
            const node = walker.currentNode
            if (node.nodeValue?.includes('{{'))
              targets.current.push({ node, template: node.nodeValue })
          }
          doc.querySelectorAll('*').forEach((node) => {
            for (const attribute of [...node.attributes]) {
              if (attribute.value.includes('{{'))
                targets.current.push({ node, attribute: attribute.name, template: attribute.value })
            }
          })
          refresh()
        }}
      />
      {failed && <span className="canvas-html-error">组件加载失败，请重新编辑 HTML。</span>}
    </>
  )
}
