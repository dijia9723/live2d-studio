/** 文件职责：本机舞台模板、快照与应用撤销；计数按保存时的值重新开始。 */
import { create } from 'zustand'
import type { CanvasCounter, CanvasWidget } from '../types/canvas'
import { defaultModelPosition, stageAspectPresets, type StageAppearance } from '../types/stage'
import { counterValue } from '../utils/canvas'
import { notify, useStudio } from './studio'
import { useCanvas } from './canvas'
import { backgroundHTMLPresets, overlayHTMLPresets } from '../components/stage/stageHTMLPresets'

interface StageSnapshot {
  appearance: StageAppearance
  widgets: CanvasWidget[]
  counters: CanvasCounter[]
}

interface StageTemplate {
  id: string
  name: string
  savedAt: number
  snapshot: StageSnapshot
}

interface TemplatesState {
  templates: StageTemplate[]
  previous: StageSnapshot | null
  deleted: StageTemplate | null
  save: (name: string, replaceID?: string) => boolean
  rename: (id: string, name: string) => boolean
  remove: (id: string) => void
  restoreDeleted: () => void
  apply: (id: string) => void
  undoApply: () => void
}

const storageKey = 'live2d-studio-stage-templates'
export const maxStageTemplates = 20

function readTemplates(): StageTemplate[] {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey) || 'null')
    if (data?.version !== 1 || !Array.isArray(data.templates)) return []
    return data.templates
      .filter(
        (item: StageTemplate) =>
          typeof item?.id === 'string' &&
          typeof item.name === 'string' &&
          Number.isFinite(item.savedAt) &&
          item.snapshot?.appearance &&
          Array.isArray(item.snapshot.widgets) &&
          Array.isArray(item.snapshot.counters) &&
          stageAspectPresets.some((preset) => preset.id === item.snapshot.appearance.aspect),
      )
      .slice(0, maxStageTemplates)
  } catch {
    return []
  }
}

function captureStage(): StageSnapshot {
  const s = useStudio.getState()
  const canvas = useCanvas.getState()
  const now = Date.now()
  return structuredClone({
    appearance: {
      stage: s.stage,
      aspect: s.aspect,
      controlsVisible: s.controlsVisible,
      backgroundAssetID: s.backgroundAssetID,
      backgroundFit: s.backgroundFit,
      backgroundDim: s.backgroundDim,
      videoPlaying: s.videoPlaying,
      effects: s.effects,
      overlayAssetID: s.overlayAssetID,
      overlayOpacity: s.overlayOpacity,
      overlayBlendMode: s.overlayBlendMode,
      zoom: s.zoom,
      modelPosition: s.modelPosition,
    },
    widgets: canvas.widgets,
    counters: canvas.counters.map((counter) => ({
      ...counter,
      value: counterValue(counter, now),
      startedAt: now,
    })),
  })
}

/** 丢失的素材回退到内置背景，模板中的其他设置继续恢复。 */
function restoreStage(snapshot: StageSnapshot) {
  const { appearance, widgets, counters } = structuredClone(snapshot)
  const assets = useStudio.getState().sceneAssets
  let missing = false
  for (const key of ['backgroundAssetID', 'overlayAssetID'] as const) {
    const presets = key === 'backgroundAssetID' ? backgroundHTMLPresets : overlayHTMLPresets
    if (
      appearance[key] &&
      !presets.some((preset) => preset.id === appearance[key]) &&
      !assets.some((asset) => asset.id === appearance[key] && (key !== 'overlayAssetID' || asset.kind !== 'html'))
    ) {
      appearance[key] = null
      missing = true
    }
  }
  useStudio.getState().patch({
    ...appearance,
    modelPosition: appearance.modelPosition ?? defaultModelPosition,
  })
  const now = Date.now()
  useCanvas.setState({
    widgets,
    counters: counters.map((counter) => ({ ...counter, startedAt: now })),
    editing: false,
    selectedID: null,
    removed: null,
  })
  return missing
}

export const useStageTemplates = create<TemplatesState>((set, get) => {
  // 先写入存储，再更新界面；容量不足时保留原模板，明确报告保存失败。
  const commit = (templates: StageTemplate[]) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ version: 1, templates }))
      set({ templates })
      return true
    } catch {
      notify('模板保存失败：本机存储不可用或空间不足，请删除不需要的模板后重试')
      return false
    }
  }
  return {
    templates: readTemplates(),
    previous: null,
    deleted: null,
    save: (name, replaceID) => {
      name = name.trim().slice(0, 60)
      if (!name) return false
      const templates = get().templates
      if (!replaceID && templates.length >= maxStageTemplates) {
        notify(`最多保存 ${maxStageTemplates} 个舞台模板`)
        return false
      }
      const template = {
        id: replaceID || crypto.randomUUID(),
        name,
        savedAt: Date.now(),
        snapshot: captureStage(),
      }
      const next = replaceID
        ? templates.map((item) => (item.id === replaceID ? template : item))
        : [template, ...templates]
      if (!commit(next)) return false
      notify(`已${replaceID ? '更新' : '保存'}模板「${name}」`)
      return true
    },
    rename: (id, name) => {
      name = name.trim().slice(0, 60)
      return (
        !!name && commit(get().templates.map((item) => (item.id === id ? { ...item, name } : item)))
      )
    },
    remove: (id) => {
      const deleted = get().templates.find((item) => item.id === id)
      if (deleted && commit(get().templates.filter((item) => item.id !== id))) set({ deleted })
    },
    restoreDeleted: () => {
      const { deleted, templates } = get()
      if (deleted && templates.length < maxStageTemplates && commit([deleted, ...templates]))
        set({ deleted: null })
    },
    apply: (id) => {
      const template = get().templates.find((item) => item.id === id)
      if (!template) return
      const previous = captureStage()
      const missing = restoreStage(template.snapshot)
      set({ previous })
      notify(`已应用「${template.name}」${missing ? '，部分素材已删除，已跳过缺失素材' : ''}`)
    },
    undoApply: () => {
      const previous = get().previous
      if (!previous) return
      restoreStage(previous)
      set({ previous: null })
      notify('已恢复应用模板前的舞台')
    },
  }
})
