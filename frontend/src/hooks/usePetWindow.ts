/**
 * 文件职责：桌宠窗口的拖拽与气泡方位 Hook。
 * 通过 Wails 运行时移动原生窗口，并依据窗口与屏幕中心的相对位置决定气泡朝向。
 */
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent } from 'react'

interface Point {
  x: number
  y: number
}

/** Wails 运行时中桌宠窗口用到的最小接口。 */
interface PetRuntime {
  Window: {
    Position(): Promise<Point>
    SetPosition(x: number, y: number): Promise<void>
    GetScreen(): Promise<{ WorkArea: { X: number; Width: number } }>
    SetAlwaysOnTop(enabled: boolean): Promise<void>
  }
  Events: {
    On(name: string, callback: () => void): () => void
  }
}

const runtimeURL = '/wails/runtime.js'

/** 按需加载 Wails 运行时，网页环境下不会请求该脚本。 */
export async function petRuntime(): Promise<PetRuntime> {
  return import(/* @vite-ignore */ runtimeURL)
}

interface Drag {
  pointerID: number
  start: Point
  delta: Point
  canvas: boolean
  moving: boolean
  pending: boolean
  origin?: Point
}

// 小于该位移视为点击而非拖拽，避免误触发窗口移动。
const dragThreshold = 8

/**
 * 管理桌宠窗口的拖拽手势与气泡方位。
 * @param showBubble 是否显示气泡；仅在显示时监听窗口移动
 * @returns native：是否为原生桌面窗口；bubbleSide：气泡应显示在角色哪一侧；
 *          dragHandlers/finishDrag：绑定到角色容器的指针事件
 */
export function usePetWindow(showBubble: boolean) {
  const native = !!(window as Window & { _wails?: unknown })._wails
  const [bubbleSide, setBubbleSide] = useState<'left' | 'right'>('right')
  const drag = useRef<Drag>(null)
  const move = useRef(Promise.resolve())

  useEffect(() => {
    if (!native || !showBubble) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    let version = 0
    void petRuntime()
      .then(({ Window, Events }) => {
        if (cancelled) return
        const update = () => {
          // 频繁的窗口移动事件里，只采用最后一次请求的结果，避免方位来回跳变。
          const request = ++version
          void Promise.all([Window.Position(), Window.GetScreen()])
            .then(([position, screen]) => {
              if (cancelled || request !== version) return
              // 窗口中心在工作区中线左侧时气泡朝右，否则朝左，确保气泡不出屏。
              const center = position.x + window.innerWidth / 2
              const screenCenter = screen.WorkArea.X + screen.WorkArea.Width / 2
              setBubbleSide(center <= screenCenter ? 'right' : 'left')
            })
            .catch(() => {})
        }
        const unlisten = Events.On('common:WindowDidMove', update)
        window.addEventListener('resize', update)
        unsubscribe = () => {
          unlisten()
          window.removeEventListener('resize', update)
        }
        update()
      })
      .catch(() => {})
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [native, showBubble])

  function onPointerDown(event: PointerEvent<HTMLElement>) {
    // 只处理原生窗口中的主键；按钮和交互元素保留自身点击行为。
    if (!native || event.button !== 0 || !event.isPrimary || drag.current) return
    const target = event.target
    if (!(target instanceof Element) || target.closest('button')) return
    target.setPointerCapture(event.pointerId)
    drag.current = {
      pointerID: event.pointerId,
      start: { x: event.screenX, y: event.screenY },
      delta: { x: 0, y: 0 },
      canvas: target instanceof HTMLCanvasElement,
      moving: false,
      pending: false,
    }
  }

  function onPointerMove(event: PointerEvent<HTMLElement>) {
    const current = drag.current
    if (!current || current.pointerID !== event.pointerId) return
    const x = event.screenX - current.start.x
    const y = event.screenY - current.start.y
    if (!current.moving && Math.hypot(x, y) < dragThreshold) return
    if (x === current.delta.x && y === current.delta.y) return
    current.delta = { x, y }
    current.moving = true
    // pending 表示已有一次移动链在跑；拖动中的最新位移会被该链循环取用。
    if (current.pending) return
    current.pending = true
    // 使用屏幕坐标和原生窗口位置，避免窗口移动后拖拽原点跟着改变。
    move.current = move.current
      .then(async () => {
        const { Window } = await petRuntime()
        const origin = (current.origin ??= await Window.Position())
        let delta: Point
        do {
          delta = current.delta
          await Window.SetPosition(Math.round(origin.x + delta.x), Math.round(origin.y + delta.y))
        } while (delta !== current.delta)
      })
      .catch(() => {})
      .finally(() => {
        current.pending = false
      })
  }

  function finishDrag(event: PointerEvent<HTMLElement>) {
    const current = drag.current
    if (!current || current.pointerID !== event.pointerId) return false
    onPointerMove(event)
    drag.current = null
    // 未发生位移且按在画布上时，视为点击角色（交给上层处理）。
    return !current.moving && current.canvas
  }

  function cancelDrag(event: PointerEvent<HTMLElement>) {
    if (drag.current?.pointerID === event.pointerId) drag.current = null
  }

  return {
    native,
    bubbleSide,
    dragHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerCancel: cancelDrag,
      onLostPointerCapture: cancelDrag,
    },
    finishDrag,
  }
}
