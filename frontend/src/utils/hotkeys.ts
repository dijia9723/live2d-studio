export interface HotkeyChord {
  key: string | null
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

export const hotkeyActions = {
  panCanvas: { label: '移动模型', trigger: 'drag' },
  zoomCanvas: { label: '缩放模型', trigger: 'wheel' },
  resetCanvas: { label: '重置模型位置与缩放', trigger: 'key' },
  toggleControls: { label: '显示或隐藏画布按钮', trigger: 'key' },
  toggleFullscreen: { label: '切换舞台全屏', trigger: 'key' },
  toggleCamera: { label: '开启或关闭摄像头跟随', trigger: 'key' },
  newConversation: { label: '开始新对话', trigger: 'key' },
} as const

export type HotkeyAction = keyof typeof hotkeyActions
export type HotkeyBindings = Record<HotkeyAction, HotkeyChord | null>
export const hotkeyActionIDs = Object.keys(hotkeyActions) as HotkeyAction[]

const noModifiers = { ctrl: false, alt: false, shift: false, meta: false }
export const defaultHotkeys: HotkeyBindings = {
  panCanvas: { ...noModifiers, key: 'Space' },
  zoomCanvas: { ...noModifiers, ctrl: true, key: null },
  resetCanvas: null,
  toggleControls: { ...noModifiers, key: 'H' },
  toggleFullscreen: null,
  toggleCamera: null,
  newConversation: null,
}

export function hotkeyKey(value: string) {
  if (
    ['Alt', 'AltGraph', 'Control', 'Meta', 'Shift', 'Unidentified', 'Dead', 'Process'].includes(
      value,
    )
  ) {
    return null
  }
  if (value === ' ') return 'Space'
  return value.length === 1 ? value.toUpperCase() : value
}

export function readChord(event: MouseEvent | KeyboardEvent, key: string | null): HotkeyChord {
  return { key, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey }
}

export function matchesModifiers(chord: HotkeyChord, event: MouseEvent | KeyboardEvent) {
  return (
    chord.ctrl === event.ctrlKey &&
    chord.alt === event.altKey &&
    chord.shift === event.shiftKey &&
    chord.meta === event.metaKey
  )
}

export function hotkeyConflict(bindings: HotkeyBindings, action: HotkeyAction, chord: HotkeyChord) {
  const trigger = hotkeyActions[action].trigger
  return hotkeyActionIDs.find((id) => {
    const other = bindings[id]
    const otherTrigger = hotkeyActions[id].trigger
    return (
      id !== action &&
      other &&
      (trigger === otherTrigger || trigger === 'key' || otherTrigger === 'key') &&
      other.key === chord.key &&
      other.ctrl === chord.ctrl &&
      other.alt === chord.alt &&
      other.shift === chord.shift &&
      other.meta === chord.meta
    )
  })
}

export function formatHotkey(action: HotkeyAction, chord: HotkeyChord | null) {
  if (!chord) return '未绑定'
  const trigger = hotkeyActions[action].trigger
  return [
    chord.ctrl && 'Ctrl',
    chord.alt && 'Alt',
    chord.shift && 'Shift',
    chord.meta && 'Meta',
    chord.key === 'Space' ? '空格' : chord.key,
    trigger === 'drag' && '鼠标左键拖拽',
    trigger === 'wheel' && '滚轮',
  ]
    .filter(Boolean)
    .join(' + ')
}

export function ariaHotkey(chord: HotkeyChord | null) {
  if (!chord?.key) return undefined
  return [
    chord.ctrl && 'Control',
    chord.alt && 'Alt',
    chord.shift && 'Shift',
    chord.meta && 'Meta',
    chord.key,
  ]
    .filter(Boolean)
    .join('+')
}
