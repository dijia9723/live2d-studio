export interface Live2DExpression {
  id: string
  label: string
}

export interface Live2DMotion {
  id: string
  group: string
  index: number
  label: string
}

export interface Live2DCapabilities {
  ready: boolean
  expressions: Live2DExpression[]
  motions: Live2DMotion[]
  supportsMoods: boolean
}

export interface ParameterBinding {
  index: number
  minimum: number
  maximum: number
}

const normalize = (id: string) => id.replace(/_/g, '').toLowerCase()

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
        label: `${group || '动作'} · ${
          m.File.split(/[\\/]/)
            .pop()
            ?.replace(/\.motion3?\.json$/i, '') || index + 1
        }`,
      })),
    ),
    supportsMoods: ['ParamMouthForm', 'ParamMouthUp', 'ParamEyeLOpen', 'ParamBrowLY'].some((id) =>
      bindings.has(normalize(id)),
    ),
  }
}

export function chooseMotion(motions: Live2DMotion[], id?: string, random = Math.random) {
  if (id !== undefined) return motions.find((m) => m.id === id)
  const reactions = motions.filter((m) => !/^idle$/i.test(m.group))
  const candidates = reactions.length ? reactions : motions
  return candidates[Math.floor(random() * candidates.length)]
}

// Mood presets address only parameters actually present in the model. In particular,
// Cubism 2-converted models use PARAM_MOUTH_FORM instead of ParamMouthForm.
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
