/** 文件职责：画布元素展示与拖动、缩放、键盘微调；拖动结束后才持久化布局。 */
import { useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { Grip, LockKeyhole } from 'lucide-react'
import type { CanvasRect, CanvasWidget } from '../../types/canvas'
import { useCanvas } from '../../store/canvas'
import { useCanvasClock } from '../../hooks/useCanvasClock'
import { clampCanvasRect } from '../../utils/canvas'
import CanvasHTML from './CanvasHTML'

interface DragState {
  id: string
  mode: 'move' | 'resize'
  pointerID: number
  startX: number
  startY: number
  rect: CanvasRect
  bounds: DOMRect
}

/** onInspect 将选中的元素同步到右侧配置面板。 */
export default function CanvasLayer({
  onInspect,
  controlsVisible = true,
  scale = 1,
}: {
  onInspect: () => void
  controlsVisible?: boolean
  scale?: number
}) {
  const s = useCanvas()
  const editing = s.editing && controlsVisible
  const layer = useRef<HTMLDivElement>(null)
  const drag = useRef<DragState | null>(null)
  const [draft, setDraft] = useState<{ id: string; rect: CanvasRect } | null>(null)
  const now = useCanvasClock(s.counters)

  const begin = (
    event: PointerEvent<HTMLElement>,
    widget: CanvasWidget,
    mode: DragState['mode'],
  ) => {
    if (!editing || widget.locked || event.button !== 0 || !layer.current || drag.current) return
    event.preventDefault()
    event.stopPropagation()
    s.selectWidget(widget.id)
    onInspect()
    const bounds = layer.current.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return
    drag.current = {
      id: widget.id,
      mode,
      pointerID: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rect: { x: widget.x, y: widget.y, width: widget.width, height: widget.height },
      bounds,
    }
    const owner = event.currentTarget.closest<HTMLElement>('[data-widget-id]')!
    owner.focus({ preventScroll: true })
    owner.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (!current || current.pointerID !== event.pointerId) return
    const dx = ((event.clientX - current.startX) / current.bounds.width) * 100
    const dy = ((event.clientY - current.startY) / current.bounds.height) * 100
    const rect =
      current.mode === 'move'
        ? { ...current.rect, x: current.rect.x + dx, y: current.rect.y + dy }
        : {
            ...current.rect,
            width: Math.min(100 - current.rect.x, current.rect.width + dx),
            height: Math.min(100 - current.rect.y, current.rect.height + dy),
          }
    const next = { id: current.id, rect: clampCanvasRect(rect) }
    setDraft(next)
    // pointerup 可能发生在下一次 React 渲染前，保存最新坐标供提交使用。
    lastDraft.current = next
  }
  const lastDraft = useRef<typeof draft>(null)
  const finish = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const current = drag.current
    if (!current || current.pointerID !== event.pointerId) return
    drag.current = null
    if (!cancelled && lastDraft.current?.id === current.id)
      s.updateWidget(current.id, lastDraft.current.rect)
    setDraft(null)
    lastDraft.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const nudge = (event: KeyboardEvent<HTMLElement>, widget: CanvasWidget, resize = false) => {
    if (!editing || widget.locked) return
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault()
      event.stopPropagation()
      const amount = event.shiftKey ? 5 : 1
      const dx = event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0
      const dy = event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0
      s.updateWidget(
        widget.id,
        resize
          ? { width: widget.width + dx, height: widget.height + dy }
          : { x: widget.x + dx, y: widget.y + dy },
      )
    }
  }

  return (
    <div
      ref={layer}
      className={`canvas-elements ${editing ? 'is-editing' : ''}`}
      aria-label="画布标题与组件"
      style={{
        inset: `${64 * scale}px auto auto ${12 * scale}px`,
        width: `calc((100% - ${24 * scale}px) / ${scale})`,
        height: `calc((100% - ${120 * scale}px) / ${scale})`,
        transform: `scale(${scale})`,
        transformOrigin: 'top left',
      }}
    >
      {s.widgets
        .filter((widget) => widget.visible)
        .map((widget) => {
          const rect = draft?.id === widget.id ? draft.rect : widget
          const selected = s.selectedID === widget.id && editing
          return (
            <div
              key={widget.id}
              data-widget-id={widget.id}
              className={`canvas-element canvas-element-${widget.kind} ${selected ? 'is-selected' : ''} ${widget.locked ? 'is-locked' : ''}`}
              style={{
                left: `${rect.x}%`,
                top: `${rect.y}%`,
                width: `${rect.width}%`,
                height: `${rect.height}%`,
              }}
              role="group"
              tabIndex={editing ? 0 : -1}
              aria-label={`${widget.name}${widget.locked ? '，已锁定' : '，方向键移动，Shift 加速'}`}
              onFocus={() => {
                if (editing) s.selectWidget(widget.id)
              }}
              onPointerDown={(event) => begin(event, widget, 'move')}
              onPointerMove={move}
              onPointerUp={(event) => finish(event)}
              onPointerCancel={(event) => finish(event, true)}
              onLostPointerCapture={(event) => finish(event, true)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return
                nudge(event, widget)
                if (
                  editing &&
                  !widget.locked &&
                  (event.key === 'Delete' || event.key === 'Backspace')
                ) {
                  event.preventDefault()
                  s.removeWidget(widget.id)
                }
              }}
            >
              <div className="canvas-element-content" style={{ opacity: widget.opacity }}>
                {widget.kind === 'title' ? (
                  <div
                    className="canvas-title"
                    style={{
                      color: widget.color,
                      fontSize: widget.fontSize,
                      fontWeight: widget.bold ? 700 : 400,
                      textAlign: widget.align,
                    }}
                  >
                    {widget.text}
                  </div>
                ) : (
                  <CanvasHTML widget={widget} counters={s.counters} now={now} />
                )}
              </div>
              {editing && (
                <span className="canvas-element-label">
                  {widget.locked ? <LockKeyhole size={10} /> : <Grip size={10} />}
                  {widget.name}
                </span>
              )}
              {selected && !widget.locked && (
                <button
                  className="canvas-resize-handle"
                  aria-label={`调整 ${widget.name} 大小，方向键微调`}
                  onPointerDown={(event) => begin(event, widget, 'resize')}
                  onKeyDown={(event) => nudge(event, widget, true)}
                />
              )}
            </div>
          )
        })}
      {editing && <span className="canvas-edit-hint">拖动移动 · 右下角缩放 · 方向键微调</span>}
    </div>
  )
}
