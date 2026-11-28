/**
 * 文件职责：快捷键管理设置。
 * 列出可绑定动作，支持录入新热键、清除、恢复默认，并在录入时检测冲突。
 */
import { useRef, useState, type KeyboardEvent } from 'react'
import { Keyboard, Pencil, RotateCcw, X } from 'lucide-react'
import { useHotkeys } from '../../store/hotkeys'
import { useStudio } from '../../store/studio'
import { supportsDesktopSnip } from '../../hooks/useDesktopSnip'
import {
  formatHotkey,
  hotkeyActionIDs,
  hotkeyActions,
  hotkeyConflict,
  hotkeyKey,
  readChord,
  type HotkeyAction,
  type HotkeyChord,
} from '../../utils/hotkeys'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'

/** 快捷键管理面板。 */
export default function HotkeySettings() {
  const { bindings, bind, reset } = useHotkeys()
  const desktop = useStudio((state) => state.desktop)
  const screenSnipAvailable = supportsDesktopSnip(desktop)
  // 网页端没有原生框选能力，隐藏对应动作，避免用户绑定无效热键。
  const actions = screenSnipAvailable
    ? hotkeyActionIDs
    : hotkeyActionIDs.filter((action) => action !== 'captureScreen')
  const [editing, setEditing] = useState<HotkeyAction | null>(null)
  const [candidate, setCandidate] = useState<HotkeyChord | null>(null)
  const recorder = useRef<HTMLInputElement>(null)
  const editButton = useRef<HTMLButtonElement | null>(null)
  const conflict =
    editing && candidate
      ? hotkeyConflict(
          // 不可用的截图动作按未绑定处理，避免它误报冲突。
          screenSnipAvailable ? bindings : { ...bindings, captureScreen: null },
          editing,
          candidate,
        )
      : undefined

  const capture = (event: KeyboardEvent<HTMLInputElement>) => {
    // Esc/Tab 用于关闭/移动焦点，输入法组合态也不应被记录为热键。
    if (!editing || event.key === 'Escape' || event.key === 'Tab' || event.nativeEvent.isComposing)
      return
    event.preventDefault()
    const key = hotkeyKey(event.key)
    const chord = readChord(event.nativeEvent, key)
    if (
      key ||
      (hotkeyActions[editing].trigger !== 'key' &&
        (chord.ctrl || chord.alt || chord.shift || chord.meta))
    ) {
      setCandidate(chord)
    }
  }

  return (
    <section className="settings-card hotkey-settings">
      <div className="card-heading">
        <span className="card-icon">
          <Keyboard size={21} aria-hidden="true" />
        </span>
        <div>
          <h2>热键管理</h2>
          <p>热键在工作台生效，更改后会自动保存在本机。</p>
        </div>
      </div>
      <ul className="hotkey-list">
        {actions.map((action) => {
          const { label } = hotkeyActions[action]
          const chord = bindings[action]
          return (
            <li key={action}>
              <span>{label}</span>
              <kbd>{formatHotkey(action, chord)}</kbd>
              <div className="hotkey-row-actions">
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`修改${label}热键`}
                  title="修改热键"
                  onClick={(event) => {
                    editButton.current = event.currentTarget
                    setCandidate(null)
                    setEditing(action)
                  }}
                >
                  <Pencil size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`清除${label}热键`}
                  title="清除热键"
                  disabled={!chord}
                  onClick={() => bind(action, null)}
                >
                  <X size={17} aria-hidden="true" />
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      <button type="button" className="button ghost" onClick={reset}>
        <RotateCcw size={15} aria-hidden="true" /> 恢复默认热键
      </button>

      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
      >
        <DialogContent
          className="modal shell-dialog"
          showCloseButton={false}
          onOpenAutoFocus={(event) => {
            // 打开后直接聚焦录入框，用户可以立即按键录入。
            event.preventDefault()
            recorder.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            // 关闭后把焦点还回原来的编辑按钮，保持键盘操作连续。
            event.preventDefault()
            editButton.current?.focus()
          }}
        >
          {editing && (
            <>
              <DialogTitle>修改{hotkeyActions[editing].label}热键</DialogTitle>
              <DialogDescription>
                {hotkeyActions[editing].trigger === 'drag'
                  ? '按下拖拽时需要同时按住的键。'
                  : hotkeyActions[editing].trigger === 'wheel'
                    ? '按下滚动鼠标滚轮时需要同时按住的键。'
                    : '按下要绑定的按键或组合键。'}
              </DialogDescription>
              <label className="form-field">
                新热键
                <input
                  ref={recorder}
                  value={candidate ? formatHotkey(editing, candidate) : ''}
                  placeholder="按下按键…"
                  readOnly
                  onKeyDown={capture}
                />
              </label>
              {conflict && (
                <p className="dialog-error" role="alert">
                  已绑定到「{hotkeyActions[conflict].label}」。
                </p>
              )}
              <div className="modal-actions">
                <button type="button" className="button ghost" onClick={() => setEditing(null)}>
                  取消
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={!candidate || !!conflict}
                  onClick={() => {
                    if (!candidate || conflict) return
                    bind(editing, candidate)
                    setEditing(null)
                  }}
                >
                  保存热键
                </button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
