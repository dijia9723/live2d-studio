/**
 * 文件职责：舞台特效的持久化设置类型。
 */

/** 单个氛围特效的开关与强度（0–1）。 */
export interface StageEffectSetting {
  id: string
  enabled: boolean
  intensity: number
}

export const stageAspectPresets = [
  { id: 'auto', label: '自适应', ratio: 0 },
  { id: '9:16', label: '9:16 · 竖屏', ratio: 9 / 16 },
  { id: '16:9', label: '16:9 · 横屏', ratio: 16 / 9 },
  { id: '1:1', label: '1:1 · 方形', ratio: 1 },
  { id: '4:3', label: '4:3 · 横屏', ratio: 4 / 3 },
  { id: '3:4', label: '3:4 · 竖屏', ratio: 3 / 4 },
  { id: '21:9', label: '21:9 · 宽屏', ratio: 21 / 9 },
] as const

export type StageAspect = (typeof stageAspectPresets)[number]['id']

/** 模型中心在可用绘制区域中的归一化坐标。 */
export interface ModelPosition {
  x: number
  y: number
}

/** 工作台缩放上下限，以整数百分比保存。 */
export interface ModelZoomLimits {
  min: number
  max: number
}

/** 模型中心可移动的边界，以绘制区域宽高的百分比保存。 */
export interface ModelDragLimits {
  left: number
  right: number
  top: number
  bottom: number
}

export const defaultModelPosition: ModelPosition = { x: 0.5, y: 0.515 }
export const defaultModelZoomLimits: ModelZoomLimits = { min: 10, max: 500 }
export const defaultModelDragLimits: ModelDragLimits = {
  left: -25,
  right: 125,
  top: -25,
  bottom: 125,
}
export const modelZoomPercentBounds = { min: 1, max: 10000 }

export function validModelZoomLimits(
  limits: ModelZoomLimits | undefined,
): limits is ModelZoomLimits {
  return (
    !!limits &&
    Number.isInteger(limits.min) &&
    Number.isInteger(limits.max) &&
    limits.min >= modelZoomPercentBounds.min &&
    limits.min <= limits.max &&
    limits.max <= modelZoomPercentBounds.max
  )
}

export function clampModelZoom(zoom: number, limits: ModelZoomLimits) {
  const scale = typeof zoom === 'number' && !Number.isNaN(zoom) ? zoom : 1
  return Math.max(limits.min / 100, Math.min(limits.max / 100, scale))
}

export function validModelDragLimits(
  limits: ModelDragLimits | undefined,
): limits is ModelDragLimits {
  return (
    !!limits &&
    Number.isSafeInteger(limits.left) &&
    Number.isSafeInteger(limits.right) &&
    Number.isSafeInteger(limits.top) &&
    Number.isSafeInteger(limits.bottom) &&
    limits.left <= limits.right &&
    limits.top <= limits.bottom
  )
}

export function clampModelPosition(
  position: ModelPosition | null | undefined,
  limits: ModelDragLimits,
): ModelPosition {
  const { x, y } = position ?? defaultModelPosition
  return {
    x: Math.max(
      limits.left / 100,
      Math.min(limits.right / 100, Number.isFinite(x) ? x : defaultModelPosition.x),
    ),
    y: Math.max(
      limits.top / 100,
      Math.min(limits.bottom / 100, Number.isFinite(y) ? y : defaultModelPosition.y),
    ),
  }
}

/** 可保存为模板的舞台外观，不包含会话、角色身份和服务配置。 */
export interface StageAppearance {
  stage: string
  aspect: StageAspect
  controlsVisible: boolean
  backgroundAssetID: string | null
  backgroundFit: 'cover' | 'contain'
  backgroundDim: number
  videoPlaying: boolean
  effects: StageEffectSetting[]
  overlayAssetID: string | null
  overlayOpacity: number
  overlayBlendMode: 'normal' | 'screen' | 'lighten'
  zoom: number
  modelPosition: ModelPosition
}
