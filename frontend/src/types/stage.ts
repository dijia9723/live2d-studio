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
}
