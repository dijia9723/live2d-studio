/**
 * 文件职责：舞台特效的持久化设置类型。
 */

/** 单个氛围特效的开关与强度（0–1）。 */
export interface StageEffectSetting {
  id: string
  enabled: boolean
  intensity: number
}
