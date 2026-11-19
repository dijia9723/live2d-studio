import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  defaultHotkeys,
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
      merge: (stored, state) => ({
        ...state,
        bindings: { ...defaultHotkeys, ...(stored as Partial<State> | undefined)?.bindings },
      }),
    },
  ),
)
