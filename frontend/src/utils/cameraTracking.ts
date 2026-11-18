import type { FaceLandmarkerResult, Landmark, PoseLandmarkerResult } from '@mediapipe/tasks-vision'
import type { ParameterBinding } from './live2d.ts'

const parameterNames = {
  anglex: ['paramanglex'],
  angley: ['paramangley'],
  anglez: ['paramanglez'],
  eyelopen: ['parameyelopen'],
  eyeropen: ['parameyeropen'],
  eyeballx: ['parameyeballx'],
  eyebally: ['parameyebally'],
  browly: ['parambrowly'],
  browry: ['parambrowry'],
  mouthopen: ['parammouthopeny', 'parama'],
  mouthform: ['parammouthform'],
  bodyx: ['parambodyanglex', 'parambodyx'],
  bodyy: ['parambodyangley', 'parambodyy'],
  bodyz: ['parambodyanglez', 'parambodyz'],
} as const

type Channel = keyof typeof parameterNames
type TrackingValues = Partial<Record<Channel, number>>

export interface CameraSample {
  time: number
  values: TrackingValues
}

export const cameraSampleMaxAge = 350
const channelHold = 220
const degrees = 180 / Math.PI
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function faceTrackingValues(face: FaceLandmarkerResult): TrackingValues {
  const values: TrackingValues = {}
  const matrix = face.facialTransformationMatrixes[0]
  if (matrix?.rows === 4 && matrix.columns === 4 && matrix.data.length === 16) {
    const { data } = matrix
    values.anglex = clamp(-Math.atan2(-data[2], Math.hypot(data[6], data[10])) * degrees, -30, 30)
    values.angley = clamp(-Math.atan2(data[6], data[10]) * degrees, -30, 30)
    values.anglez = clamp(-Math.atan2(data[1], data[0]) * degrees, -30, 30)
  }

  const categories = face.faceBlendshapes[0]?.categories
  if (categories?.length) {
    const scores = new Map(categories.map(({ categoryName, score }) => [categoryName, score]))
    const score = (name: string) => scores.get(name) ?? 0
    const eye = (side: string) => clamp(1 - score(`eyeBlink${side}`) * 1.4, 0, 1)
    const brow = (side: string) =>
      clamp(score('browInnerUp') + score(`browOuterUp${side}`) - score(`browDown${side}`), -1, 1)
    const average = (feature: string) => (score(`${feature}Left`) + score(`${feature}Right`)) / 2
    values.eyelopen = eye('Right')
    values.eyeropen = eye('Left')
    values.browly = brow('Right')
    values.browry = brow('Left')
    values.eyeballx = clamp(
      score('eyeLookInLeft') +
        score('eyeLookOutRight') -
        score('eyeLookOutLeft') -
        score('eyeLookInRight'),
      -1,
      1,
    )
    values.eyebally = clamp(average('eyeLookUp') - average('eyeLookDown'), -1, 1)
    values.mouthopen = clamp((score('jawOpen') - 0.03) * 1.6, 0, 1)
    values.mouthform = clamp((average('mouthSmile') - average('mouthFrown')) * 1.4, -1, 1)
  }
  return values
}

function isVisible(point: Landmark | undefined): point is Landmark {
  return !!point && point.visibility >= 0.55 && [point.x, point.y, point.z].every(Number.isFinite)
}

export function bodyTrackingValues(
  pose: PoseLandmarkerResult,
  face?: FaceLandmarkerResult,
): TrackingValues {
  const nose = pose.landmarks[0]?.[0]
  const faceNose = face?.faceLandmarks[0]?.[1]
  if (faceNose && (!isVisible(nose) || Math.hypot(nose.x - faceNose.x, nose.y - faceNose.y) > 0.15))
    return {}

  const landmarks = pose.worldLandmarks[0]
  const left = landmarks?.[11]
  const right = landmarks?.[12]
  if (!isVisible(left) || !isVisible(right)) return {}
  const width = left.x - right.x
  const depth = left.z - right.z
  if (Math.hypot(width, depth) < 0.08) return {}

  const values: TrackingValues = {
    bodyx: clamp((-Math.atan2(depth, Math.abs(width)) * degrees) / 2, -10, 10),
  }
  if (width > 0.08) values.bodyz = clamp(Math.atan2(left.y - right.y, width) * degrees, -10, 10)
  const leftHip = landmarks[23]
  const rightHip = landmarks[24]
  if (isVisible(leftHip) && isVisible(rightHip)) {
    const height = (leftHip.y + rightHip.y - left.y - right.y) / 2
    const lean = (leftHip.z + rightHip.z - left.z - right.z) / 2
    if (height > 0.1) values.bodyy = clamp((-Math.atan2(lean, height) * degrees) / 2, -10, 10)
  }
  return values
}

export function currentCameraSample(sample: CameraSample | null, now: number) {
  return sample && now - sample.time < cameraSampleMaxAge ? sample.values : null
}

export function createCameraSampleBuffer() {
  const latest = new Map<Channel, { time: number; value: number }>()
  return (time: number, updates?: TrackingValues): CameraSample | null => {
    if (updates) {
      for (const channel of Object.keys(updates) as Channel[]) {
        const value = updates[channel]
        if (value !== undefined && Number.isFinite(value)) latest.set(channel, { time, value })
      }
    }
    const values: TrackingValues = {}
    for (const [channel, sample] of latest) {
      if (time - sample.time >= channelHold) latest.delete(channel)
      else values[channel] = sample.value
    }
    return latest.size ? { time, values } : null
  }
}

function responseTime(channel: Channel) {
  if (channel.startsWith('body')) return 110
  if (channel === 'eyelopen' || channel === 'eyeropen' || channel === 'mouthopen') return 30
  return 65
}

export function createCameraParameterDriver(bindings: Map<string, ParameterBinding>) {
  const channels = (Object.keys(parameterNames) as Channel[]).flatMap((name) => {
    const binding = parameterNames[name].map((id) => bindings.get(id)).find(Boolean)
    return binding ? [{ name, binding, response: responseTime(name), value: 0, weight: 0 }] : []
  })

  return (
    values: TrackingValues | null,
    elapsed: number,
    apply: (index: number, value: number, weight: number) => void,
  ) => {
    const delta = clamp(elapsed, 0, 100)
    const influence = 1 - Math.exp(-delta / 85)
    for (const channel of channels) {
      const { name, binding } = channel
      const target = values?.[name]
      if (target !== undefined && Number.isFinite(target)) {
        const next = clamp(target, binding.minimum, binding.maximum)
        const smooth = 1 - Math.exp(-delta / channel.response)
        channel.value += (next - channel.value) * (channel.weight ? smooth : 1)
        channel.weight += (1 - channel.weight) * influence
      } else {
        channel.weight *= 1 - influence
      }
      if (channel.weight >= 0.01) apply(binding.index, channel.value, channel.weight)
      else channel.weight = 0
    }
  }
}
