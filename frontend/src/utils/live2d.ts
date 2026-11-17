/**
 * 文件职责：Live2D 模型的参数/表情/动作能力封装（纯函数，便于单元测试）。
 * 核心目标是兼容两套 Cubism 参数命名（ParamXxx 与 PARAM_XXX）并只写入模型真实存在的参数。
 */

/** 模型自带表情的展示信息。 */
export interface Live2DExpression {
  id: string
  label: string
}

/** 模型自带动作；id 用 group+index 序列化，避免依赖库内部的回调。 */
export interface Live2DMotion {
  id: string
  group: string
  index: number
  label: string
}

/** 舞台可用于 UI 的能力描述。 */
export interface Live2DCapabilities {
  ready: boolean
  expressions: Live2DExpression[]
  motions: Live2DMotion[]
  supportsMoods: boolean
}

/** 参数索引与取值范围，用于把情绪值钳制到模型允许的区间。 */
export interface ParameterBinding {
  index: number
  minimum: number
  maximum: number
}

/** 归一化参数 ID：去掉下划线并转小写，使 ParamXxx 与 PARAM_XXX 命中同一个键。 */
const normalize = (id: string) => id.replace(/_/g, '').toLowerCase()

/**
 * 建立“归一化参数名 → 索引/范围”的映射。
 * 后续所有参数写入都通过它查找，保证不会写入不存在的参数。
 */
export function createParameterBindings(
  ids: readonly string[],
  minimumValues: ArrayLike<number>,
  maximumValues: ArrayLike<number>,
) {
  const bindings = new Map<string, ParameterBinding>()
  ids.forEach((id, index) => {
    bindings.set(normalize(id), {
      index,
      minimum: minimumValues[index],
      maximum: maximumValues[index],
    })
  })
  return bindings
}

/** 从 model3.json 的 Expressions / Motions 定义推导舞台可用的表情与动作列表。 */
export function modelCapabilities(
  expressions: { Name: string; File: string }[] | undefined,
  motions: Partial<Record<string, { File: string }[]>>,
  bindings: Map<string, ParameterBinding>,
): Live2DCapabilities {
  return {
    ready: true,
    expressions: (expressions || []).map((e) => ({ id: e.Name, label: e.Name })),
    motions: Object.entries(motions).flatMap(([group, items]) =>
      (items || []).map((m, index) => ({
        id: JSON.stringify([group, index]),
        group,
        index,
        // 用文件名（去掉 .motion3.json 后缀）作为展示名，空组名回退为“动作”。
        label: `${group || '动作'} · ${
          m.File.split(/[\\/]/)
            .pop()
            ?.replace(/\.motion3?\.json$/i, '') || index + 1
        }`,
      })),
    ),
    // 只要命中任意一个通用面部参数即认为支持情绪预设。
    supportsMoods: ['ParamMouthForm', 'ParamMouthUp', 'ParamEyeLOpen', 'ParamBrowLY'].some((id) =>
      bindings.has(normalize(id)),
    ),
  }
}

/** 按 id 精确选择动作；未指定时优先从非 Idle 的“反应动作”中随机选择。 */
export function chooseMotion(motions: Live2DMotion[], id?: string, random = Math.random) {
  if (id !== undefined) return motions.find((m) => m.id === id)
  const reactions = motions.filter((m) => !/^idle$/i.test(m.group))
  const candidates = reactions.length ? reactions : motions
  return candidates[Math.floor(random() * candidates.length)]
}

// 情绪预设只作用于模型实际拥有的参数。特别是 Cubism 2 转换的模型使用
// PARAM_MOUTH_FORM，而不是 ParamMouthForm。
const moods: Record<string, Record<string, number>> = {
  happy: {
    ParamEyeLOpen: 0.65,
    ParamEyeROpen: 0.65,
    ParamEyeLSmile: 1,
    ParamEyeRSmile: 1,
    ParamBrowLY: 0.25,
    ParamBrowRY: 0.25,
    ParamMouthForm: 1,
    ParamMouthUp: 1,
    ParamMouthDown: 0,
    ParamMouthOpenY: 0.12,
    ParamA: 0.12,
    ParamCheek: 0.35,
    ParamTere: 0.35,
  },
  sad: {
    ParamEyeLOpen: 0.6,
    ParamEyeROpen: 0.6,
    ParamBrowLY: -0.4,
    ParamBrowRY: -0.4,
    ParamBrowLAngle: -0.6,
    ParamBrowRAngle: -0.6,
    ParamBrowLForm: -0.6,
    ParamBrowRForm: -0.6,
    ParamMouthForm: -1,
    ParamMouthUp: 0,
    ParamMouthDown: 1,
    ParamMouthOpenY: 0.05,
    ParamA: 0.05,
  },
  surprised: {
    ParamEyeLOpen: 1.2,
    ParamEyeROpen: 1.2,
    ParamBrowLY: 1,
    ParamBrowRY: 1,
    ParamMouthForm: 0,
    ParamMouthUp: 0,
    ParamMouthDown: 0,
    ParamMouthOpenY: 0.75,
    ParamA: 0.75,
    ParamO: 0.8,
  },
}

/** 把某情绪的预设值转换为可直接写入的参数列表，并钳制到模型合法区间。 */
export function moodParameters(mood: string, bindings: Map<string, ParameterBinding>) {
  return Object.entries(moods[mood] || {}).flatMap(([id, value]) => {
    const binding = bindings.get(normalize(id))
    return binding
      ? [
          {
            index: binding.index,
            value: Math.max(binding.minimum, Math.min(binding.maximum, value)),
          },
        ]
      : []
  })
}

/**
 * 选择口型同步使用的参数：优先使用模型 lipSyncIds 中声明的参数，
 * 否则回退到常见的嘴部参数；不存在的参数会被忽略。
 */
export function lipSyncParameters(
  bindings: Map<string, ParameterBinding>,
  parameterIDs: string[] = [],
) {
  const ids = parameterIDs.length ? parameterIDs : ['ParamMouthOpenY', 'ParamA']
  return ids.flatMap((id) => {
    const binding = bindings.get(normalize(id))
    return binding ? [binding] : []
  })
}
