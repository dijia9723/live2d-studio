/** 文件职责：画布元素、共享计数器和布局编辑状态；仅用户配置持久化到本机。 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { CanvasCounter, CanvasWidget } from '../types/canvas'
import {
  clampCanvasRect,
  counterValue,
  defaultCounterHTML,
  finiteNumber,
  maxCanvasCounters,
  maxCanvasWidgets,
} from '../utils/canvas'

interface CanvasState {
  widgets: CanvasWidget[]
  counters: CanvasCounter[]
  editing: boolean
  selectedID: string | null
  managerTab: 'widgets' | 'data'
  removed: { widget: CanvasWidget; index: number } | null
  setEditing: (editing: boolean) => void
  setManagerTab: (tab: 'widgets' | 'data') => void
  selectWidget: (id: string) => void
  addWidget: (kind: CanvasWidget['kind']) => void
  updateWidget: (id: string, patch: Partial<CanvasWidget>) => void
  duplicateWidget: (id: string) => void
  moveWidget: (id: string, direction: number) => void
  removeWidget: (id: string) => void
  undoRemove: () => void
  addCounter: () => void
  updateCounter: (id: string, patch: Partial<CanvasCounter>) => void
  adjustCounter: (id: string, direction: number) => void
  toggleCounter: (id: string) => void
  resetCounter: (id: string) => void
  removeCounter: (id: string) => void
}

function newCounter(index: number): CanvasCounter {
  return {
    id: crypto.randomUUID(),
    name: `计数 ${index}`,
    mode: 'manual',
    value: 0,
    initialValue: 0,
    step: 1,
    intervalSeconds: 1,
    running: false,
    startedAt: Date.now(),
  }
}

export const useCanvas = create<CanvasState>()(
  persist(
    (set, get) => ({
      widgets: [],
      counters: [],
      editing: false,
      selectedID: null,
      managerTab: 'widgets',
      removed: null,
      setEditing: (editing) => set({ editing }),
      setManagerTab: (managerTab) => set({ managerTab }),
      selectWidget: (selectedID) => set({ selectedID, editing: true, managerTab: 'widgets' }),
      addWidget: (kind) => {
        const { widgets, counters } = get()
        if (widgets.length >= maxCanvasWidgets) return
        const nextCounters = kind === 'html' && !counters.length ? [newCounter(1)] : counters
        const id = crypto.randomUUID()
        const widget: CanvasWidget = {
          id,
          kind,
          name: kind === 'title' ? '新的标题' : '计数组件',
          x: 6 + (widgets.length % 4) * 3,
          y: 10 + (widgets.length % 5) * 8,
          width: kind === 'title' ? 70 : 58,
          height: kind === 'title' ? 15 : 21,
          visible: true,
          locked: false,
          opacity: 1,
          text: '在这里写下你的标题',
          fontSize: 32,
          color: '#ffffff',
          bold: true,
          align: 'left',
          html: defaultCounterHTML,
          bindings:
            kind === 'html'
              ? [{ id: crypto.randomUUID(), alias: 'count', counterID: nextCounters[0].id }]
              : [],
        }
        set({
          widgets: [...widgets, widget],
          counters: nextCounters,
          selectedID: id,
          editing: true,
          managerTab: 'widgets',
        })
      },
      updateWidget: (id, patch) =>
        set((state) => ({
          widgets: state.widgets.map((widget) =>
            widget.id === id
              ? { ...widget, ...patch, id: widget.id, ...clampCanvasRect({ ...widget, ...patch }) }
              : widget,
          ),
        })),
      duplicateWidget: (id) => {
        const { widgets } = get()
        const widget = widgets.find((item) => item.id === id)
        if (!widget || widgets.length >= maxCanvasWidgets) return
        const copy = {
          ...widget,
          id: crypto.randomUUID(),
          name: `${widget.name} 副本`,
          locked: false,
          bindings: widget.bindings.map((binding) => ({ ...binding, id: crypto.randomUUID() })),
          ...clampCanvasRect({ ...widget, x: widget.x + 3, y: widget.y + 3 }),
        }
        set({
          widgets: [...widgets, copy],
          selectedID: copy.id,
          editing: true,
          managerTab: 'widgets',
        })
      },
      moveWidget: (id, direction) =>
        set((state) => {
          const widgets = [...state.widgets]
          const index = widgets.findIndex((item) => item.id === id)
          const target = Math.max(0, Math.min(widgets.length - 1, index + direction))
          if (index < 0) return state
          ;[widgets[index], widgets[target]] = [widgets[target], widgets[index]]
          return { widgets }
        }),
      removeWidget: (id) =>
        set((state) => {
          const index = state.widgets.findIndex((item) => item.id === id)
          if (index < 0) return state
          return {
            widgets: state.widgets.filter((item) => item.id !== id),
            selectedID: state.selectedID === id ? null : state.selectedID,
            removed: { widget: state.widgets[index], index },
          }
        }),
      undoRemove: () =>
        set((state) => {
          if (!state.removed || state.widgets.length >= maxCanvasWidgets) return state
          const widgets = [...state.widgets]
          widgets.splice(state.removed.index, 0, state.removed.widget)
          return {
            widgets,
            removed: null,
            selectedID: state.removed.widget.id,
            editing: true,
            managerTab: 'widgets',
          }
        }),
      addCounter: () =>
        set((state) =>
          state.counters.length >= maxCanvasCounters
            ? state
            : { counters: [...state.counters, newCounter(state.counters.length + 1)] },
        ),
      updateCounter: (id, patch) =>
        set((state) => ({
          counters: state.counters.map((counter) => {
            if (counter.id !== id) return counter
            const now = Date.now()
            const next = {
              ...counter,
              ...patch,
              id: counter.id,
              value: finiteNumber(patch.value ?? counterValue(counter, now)),
              startedAt: now,
            }
            next.step = Math.max(0.000001, finiteNumber(next.step, 1))
            next.initialValue = finiteNumber(next.initialValue)
            next.intervalSeconds = Math.max(
              1,
              Math.min(86400, finiteNumber(next.intervalSeconds, 1)),
            )
            if (next.mode === 'manual') next.running = false
            // 重命名不应重置自动累加的周期。
            if (Object.keys(patch).every((key) => key === 'name'))
              return { ...counter, name: next.name }
            return next
          }),
        })),
      adjustCounter: (id, direction) =>
        set((state) => ({
          counters: state.counters.map((counter) =>
            counter.id === id
              ? { ...counter, value: finiteNumber(counter.value + direction * counter.step) }
              : counter,
          ),
        })),
      toggleCounter: (id) => {
        const counter = get().counters.find((item) => item.id === id)
        if (counter?.mode === 'auto') get().updateCounter(id, { running: !counter.running })
      },
      resetCounter: (id) => {
        const counter = get().counters.find((item) => item.id === id)
        if (counter) get().updateCounter(id, { value: counter.initialValue })
      },
      removeCounter: (id) =>
        set((state) =>
          state.widgets.some((widget) =>
            widget.bindings.some((binding) => binding.counterID === id),
          )
            ? state
            : { counters: state.counters.filter((item) => item.id !== id) },
        ),
    }),
    {
      name: 'live2d-studio-canvas',
      partialize: ({ widgets, counters }) => ({ widgets, counters }),
    },
  ),
)
