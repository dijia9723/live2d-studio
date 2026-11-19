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
      merge: (stored, state) => {
        const saved = (stored as Partial<State> | undefined)?.bindings
        const bindings = { ...defaultHotkeys, ...saved }
        const capture = bindings.captureScreen
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
