import { useEffect, useRef, type RefObject } from 'react'
import type { Live2DStageHandle } from '../components/Live2DStage'
import { useHotkeys } from '../store/hotkeys'
import { hotkeyKey, matchesModifiers, type HotkeyAction, type HotkeyChord } from '../utils/hotkeys'

type Commands = Partial<
  Record<Exclude<HotkeyAction, 'panCanvas' | 'zoomCanvas' | 'resetCanvas'>, () => void>
>

const typingTargets = 'input, textarea, select, [role="textbox"]'
const commandSurfaces = '[role="dialog"], dialog[open], [role="menu"], [role="listbox"]'
const clickTargets = 'button, a[href], [role="button"], [role="menuitem"]'
const blockedTarget = (target: EventTarget | null) =>
  (target instanceof HTMLElement && target.isContentEditable) ||
  (target instanceof Element && target.closest(typingTargets)) ||
  document.querySelector(commandSurfaces)

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
      if (event.defaultPrevented || event.isComposing || document.querySelector(commandSurfaces))
        return
      const key = hotkeyKey(event.key)
      if (!key) return
      const bindings = useHotkeys.getState().bindings
      if (blockedTarget(event.target)) {
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
      const activatesControl = (key === 'Space' || key === 'Enter') && target?.closest(clickTargets)
      const preparingPan =
        bindings.panCanvas?.key === key &&
        matchesModifiers(bindings.panCanvas, event) &&
        ((node.matches(':hover') && !node.querySelector(`:is(${clickTargets}):hover`)) ||
          (!activatesControl && target && node.contains(target)))
      if (activatesControl && !preparingPan) return
      pressed.set(event.code || key, key)
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
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1)
      stage.current?.zoomModelBy(Math.exp(-delta * 0.0025), event.clientX, event.clientY)
    }

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
