/**
 * 文件职责：热键的数据结构、默认绑定、按键规范化与冲突检测。
 * 同时提供展示文案与 aria-keyshortcuts 所需的格式化。
 */

/** 一组热键：按键（null 表示纯修饰键组合）+ 四个修饰键状态。 */
export interface HotkeyChord {
  key: string | null
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

/** 可绑定的动作清单；trigger 决定该动作通过键盘、拖拽还是滚轮触发。 */
export const hotkeyActions = {
  panCanvas: { label: '移动模型', trigger: 'drag' },
  zoomCanvas: { label: '缩放模型', trigger: 'wheel' },
  resetCanvas: { label: '重置模型位置与缩放', trigger: 'key' },
  toggleControls: { label: '显示或隐藏画布按钮', trigger: 'key' },
  toggleFullscreen: { label: '切换舞台全屏', trigger: 'key' },
  toggleCamera: { label: '开启或关闭摄像头跟随', trigger: 'key' },
  newConversation: { label: '开始新对话', trigger: 'key' },
  captureScreen: { label: '截取屏幕', trigger: 'key' },
} as const

export type HotkeyAction = keyof typeof hotkeyActions
/** 动作到热键的映射；null 表示未绑定。 */
export type HotkeyBindings = Record<HotkeyAction, HotkeyChord | null>
export const hotkeyActionIDs = Object.keys(hotkeyActions) as HotkeyAction[]

const noModifiers = { ctrl: false, alt: false, shift: false, meta: false }
/** 首次使用时的默认热键；部分动作默认不占用按键。 */
export const defaultHotkeys: HotkeyBindings = {
  panCanvas: { ...noModifiers, key: 'Space' },
  zoomCanvas: { ...noModifiers, ctrl: true, key: null },
  resetCanvas: null,
  toggleControls: { ...noModifiers, key: 'H' },
  toggleFullscreen: null,
  toggleCamera: null,
  newConversation: null,
  captureScreen: { ...noModifiers, ctrl: true, shift: true, key: 'S' },
}

/**
 * 规范化 KeyboardEvent.key。
 * 纯修饰键与输入法中间态返回 null，单字符统一转为大写，空格转为 'Space'。
 */
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

/** 从键盘/鼠标事件读取当前修饰键状态并组成 chord。 */
export function readChord(event: MouseEvent | KeyboardEvent, key: string | null): HotkeyChord {
  return { key, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey }
}

/** 判断事件的四组修饰键是否与 chord 完全一致。 */
export function matchesModifiers(chord: HotkeyChord, event: MouseEvent | KeyboardEvent) {
  return (
    chord.ctrl === event.ctrlKey &&
    chord.alt === event.altKey &&
    chord.shift === event.shiftKey &&
    chord.meta === event.metaKey
  )
}

/**
 * 查找与给定 chord 冲突的已绑定动作。
 * 同类触发器互相冲突；键盘动作与拖拽/滚轮动作只要按键相同也会冲突。
 * @returns 冲突动作 ID，未冲突时为 undefined
 */
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

/** 生成面向用户的热键展示文案（含拖拽/滚轮触发方式）。 */
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

/** 生成 aria-keyshortcuts 属性值；无按键时返回 undefined。 */
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
