/**
 * 文件职责：舞台快捷键与手势 Hook。
 * 把键盘热键、拖拽平移、滚轮缩放映射到舞台操作，并处理输入框、弹窗、
 * 按钮等场景下的热键冲突与默认行为拦截。
 */
import { useEffect, useRef, type RefObject } from 'react'
import type { Live2DStageHandle } from '../components/stage/Live2DStage'
import { useHotkeys } from '../store/hotkeys'
import { hotkeyKey, matchesModifiers, type HotkeyAction, type HotkeyChord } from '../utils/hotkeys'

type Commands = Partial<
  Record<Exclude<HotkeyAction, 'panCanvas' | 'zoomCanvas' | 'resetCanvas'>, () => void>
>

// 输入类元素会消费按键，命中时不再触发舞台快捷键。
const typingTargets = 'input, textarea, select, [role="textbox"]'
// 弹窗/菜单打开时快捷键应让位于它们自身的键盘操作。
const commandSurfaces = '[role="dialog"], dialog[open], [role="menu"], [role="listbox"]'
// 按钮类元素上的空格/回车用于激活控件，不能被当作平移手势。
const clickTargets = 'button, a[href], [role="button"], [role="menuitem"]'
const blockedTarget = (target: EventTarget | null) =>
  (target instanceof HTMLElement && target.isContentEditable) ||
  (target instanceof Element && target.closest(typingTargets)) ||
  document.querySelector(commandSurfaces)

/**
 * 绑定舞台快捷键与手势。
 * @param viewport 接收指针/滚轮事件的容器
 * @param stage 舞台控制器引用
 * @param ready 舞台是否已就绪，就绪后才绑定
 * @param commands 各热键动作对应的回调
 */
export function useStageHotkeys(
  viewport: RefObject<HTMLDivElement | null>,
  stage: RefObject<Live2DStageHandle | null>,
  ready: boolean,
  commands: Commands,
) {
  const latestCommands = useRef(commands)
  latestCommands.current = commands

  useEffect(() => {
    const node = viewport.current
    if (!node) return

    const pressed = new Map<string, string>()
    let drag: { pointer: number; x: number; y: number } | null = null
    // 平移/缩放是“按住某键 + 鼠标操作”的组合，需检查按住的键是否匹配。
    const matchesGesture = (chord: HotkeyChord | null, event: MouseEvent) =>
      !!chord &&
      matchesModifiers(chord, event) &&
      (!chord.key || [...pressed.values()].includes(chord.key))

    const finish = () => {
      if (!drag) return
      const { pointer } = drag
      drag = null
      stage.current?.commitModelMove()
      node.classList.remove('is-panning')
      if (node.hasPointerCapture(pointer)) node.releasePointerCapture(pointer)
    }
    const clearInput = () => {
      pressed.clear()
      finish()
    }
    const keyDown = (event: KeyboardEvent) => {
      // 输入法组合期或弹窗打开时直接放行，避免抢走按键。
      if (event.defaultPrevented || event.isComposing || document.querySelector(commandSurfaces))
        return
      const key = hotkeyKey(event.key)
      if (!key) return
      const bindings = useHotkeys.getState().bindings
      if (blockedTarget(event.target)) {
        // 输入框里只允许带修饰键的截图热键穿透，其余快捷键交给输入框。
        const capture = bindings.captureScreen
        const run = latestCommands.current.captureScreen
        if (
          run &&
          capture?.key === key &&
          (capture.ctrl || capture.alt || capture.meta) &&
          matchesModifiers(capture, event)
        ) {
          event.preventDefault()
          if (!event.repeat) run()
        }
        return
      }
      const target = event.target instanceof Element ? event.target : null
      // 空格/回车在按钮上用于激活控件，除非此时正要开始平移。
      const activatesControl = (key === 'Space' || key === 'Enter') && target?.closest(clickTargets)
      const preparingPan =
        bindings.panCanvas?.key === key &&
        matchesModifiers(bindings.panCanvas, event) &&
        ((node.matches(':hover') && !node.querySelector(`:is(${clickTargets}):hover`)) ||
          (!activatesControl && target && node.contains(target)))
      if (activatesControl && !preparingPan) return
      pressed.set(event.code || key, key)
      // 仅当确实进入平移准备时才拦截默认滚动，否则保留页面原有行为。
      if (preparingPan) event.preventDefault()
      const handlers = {
        resetCanvas: () => stage.current?.resetModelView(),
        ...latestCommands.current,
      }
      for (const [action, run] of Object.entries(handlers)) {
        const chord = bindings[action as keyof typeof handlers]
        if (run && chord?.key === key && matchesModifiers(chord, event)) {
          event.preventDefault()
          if (!event.repeat) run()
          break
        }
      }
    }
    const keyUp = (event: KeyboardEvent) => pressed.delete(event.code || hotkeyKey(event.key) || '')
    const pointerDown = (event: PointerEvent) => {
      if (
        drag ||
        event.pointerType !== 'mouse' ||
        event.button !== 0 ||
        (event.target instanceof Element && event.target.closest(clickTargets)) ||
        !matchesGesture(useHotkeys.getState().bindings.panCanvas, event) ||
        blockedTarget(event.target)
      )
        return
      event.preventDefault()
      event.stopPropagation()
      drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY }
      node.setPointerCapture(event.pointerId)
      node.classList.add('is-panning')
    }
    const pointerMove = (event: PointerEvent) => {
      if (drag?.pointer !== event.pointerId) return
      stage.current?.moveModel(event.clientX - drag.x, event.clientY - drag.y)
      drag.x = event.clientX
      drag.y = event.clientY
    }
    const pointerEnd = (event: PointerEvent) => {
      if (drag?.pointer === event.pointerId) finish()
    }
    const wheel = (event: WheelEvent) => {
      if (
        !event.deltaY ||
        !matchesGesture(useHotkeys.getState().bindings.zoomCanvas, event) ||
        blockedTarget(event.target)
      )
        return
      event.preventDefault()
      const delta =
        // 不同设备的 deltaMode 单位不同，统一换算成像素再缩放。
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1)
      stage.current?.zoomModelBy(Math.exp(-delta * 0.0025), event.clientX, event.clientY)
    }

    // 用统一的 AbortController 一次性解绑所有监听，避免遗漏。
    const listeners = new AbortController()
    const options = { signal: listeners.signal }
    window.addEventListener('keydown', keyDown, options)
    window.addEventListener('keyup', keyUp, options)
    window.addEventListener('blur', clearInput, options)
    document.addEventListener('visibilitychange', clearInput, options)
    node.addEventListener('pointerdown', pointerDown, { ...options, capture: true })
    node.addEventListener('pointermove', pointerMove, options)
    node.addEventListener('pointerup', pointerEnd, options)
    node.addEventListener('pointercancel', pointerEnd, options)
    node.addEventListener('lostpointercapture', pointerEnd, options)
    node.addEventListener('wheel', wheel, { ...options, passive: false })
    return () => {
      listeners.abort()
      clearInput()
    }
  }, [ready, stage, viewport])
}
