/**
 * 文件职责：舞台热键绑定的全局状态，并持久化到本机。
 * 只保存用户绑定，读取时与默认值合并，保证新增动作也能获得默认热键。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  defaultHotkeys,
  hotkeyConflict,
  type HotkeyAction,
  type HotkeyBindings,
  type HotkeyChord,
} from '../utils/hotkeys'

interface State {
  bindings: HotkeyBindings
  bind: (action: HotkeyAction, chord: HotkeyChord | null) => void
  reset: () => void
}

/** 热键绑定状态；bind 修改单个动作，reset 恢复全部默认值。 */
export const useHotkeys = create<State>()(
  persist(
    (set) => ({
      bindings: defaultHotkeys,
      bind: (action, chord) =>
        set((state) => ({ bindings: { ...state.bindings, [action]: chord } })),
      reset: () => set({ bindings: defaultHotkeys }),
    }),
    {
      name: 'live2d-studio-hotkeys',
      partialize: (state) => ({ bindings: state.bindings }),
      // 持久化数据可能来自旧版本，逐项合并默认值以补齐新增动作。
      merge: (stored, state) => {
        const saved = (stored as Partial<State> | undefined)?.bindings
        const bindings = { ...defaultHotkeys, ...saved }
        const capture = bindings.captureScreen
        // 旧版本没有截图热键时，若默认值与已有绑定冲突则退化为未绑定，避免抢键。
        if (
          saved?.captureScreen === undefined &&
          capture &&
          hotkeyConflict(bindings, 'captureScreen', capture)
        ) {
          bindings.captureScreen = null
        }
        return { ...state, bindings }
      },
    },
  ),
)
