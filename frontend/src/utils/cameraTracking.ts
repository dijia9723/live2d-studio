/**
 * 文件职责：摄像头识别结果到 Live2D 参数的换算。
 * 把 MediaPipe 的面部/身体关键点转换为角度与表情通道，并提供带保持与平滑的
 * 样本缓冲和参数驱动，减少抖动与掉帧带来的跳变。
 */
import type {
  FaceLandmarkerResult,
  Landmark,
  NormalizedLandmark,
  PoseLandmarkerResult,
} from '@mediapipe/tasks-vision'
import type { ParameterBinding } from './live2d.ts'

// 每个逻辑通道可匹配多个模型参数名，取模型中实际存在的第一个。
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

/** 某一时刻的参数样本；values 只包含当前有效的通道。 */
export interface CameraSample {
  time: number
  values: TrackingValues
}

interface LandmarkFrame {
  time: number
  points: NormalizedLandmark[]
}

/** 预览用关键点；face/pose 各自带时间戳，便于判断是否过期。 */
export interface CameraLandmarks {
  width: number
  height: number
  face?: LandmarkFrame
  pose?: LandmarkFrame
}

// 样本超过该时长未刷新即视为失效，避免摄像头断开后角色保持旧姿态。
export const cameraSampleMaxAge = 350
// 单个通道在停止更新后仍保留的时间，避免某一帧漏检导致参数瞬间归零。
const channelHold = 220
const degrees = 180 / Math.PI
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** 由面部结果计算头部角度与表情通道。 */
export function faceTrackingValues(face: FaceLandmarkerResult): TrackingValues {
  const values: TrackingValues = {}
  const matrix = face.facialTransformationMatrixes[0]
  // 从 4x4 变换矩阵反解俯仰/偏航/翻滚角，并限制在 ±30° 内防止夸张。
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
    // blendShape 中眨眼分数越大表示越闭眼，这里反转为睁眼程度。
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

/** 关键点是否可信：可见度足够且坐标均为有限数。 */
export function isVisiblePoseLandmark(point: Landmark | undefined): point is Landmark {
  return !!point && point.visibility >= 0.55 && [point.x, point.y, point.z].every(Number.isFinite)
}

/** 由身体姿态计算身体旋转通道；姿态不可靠时返回空对象交由上层保持旧值。 */
export function bodyTrackingValues(
  pose: PoseLandmarkerResult,
  face?: FaceLandmarkerResult,
): TrackingValues {
  const nose = pose.landmarks[0]?.[0]
  const faceNose = face?.faceLandmarks[0]?.[1]
  // 姿态与面部鼻尖偏差过大说明姿态关键点串位（例如只拍到半身），放弃本次结果。
  if (
    faceNose &&
    (!isVisiblePoseLandmark(nose) || Math.hypot(nose.x - faceNose.x, nose.y - faceNose.y) > 0.15)
  )
    return {}

  const landmarks = pose.worldLandmarks[0]
  const left = landmarks?.[11]
  const right = landmarks?.[12]
  if (!isVisiblePoseLandmark(left) || !isVisiblePoseLandmark(right)) return {}
  const width = left.x - right.x
  const depth = left.z - right.z
  // 双肩过窄通常意味着侧身或距离过远，角度不可信。
  if (Math.hypot(width, depth) < 0.08) return {}

  const values: TrackingValues = {
    bodyx: clamp((-Math.atan2(depth, Math.abs(width)) * degrees) / 2, -10, 10),
  }
  if (width > 0.08) values.bodyz = clamp(Math.atan2(left.y - right.y, width) * degrees, -10, 10)
  const leftHip = landmarks[23]
  const rightHip = landmarks[24]
  if (isVisiblePoseLandmark(leftHip) && isVisiblePoseLandmark(rightHip)) {
    const height = (leftHip.y + rightHip.y - left.y - right.y) / 2
    const lean = (leftHip.z + rightHip.z - left.z - right.z) / 2
    if (height > 0.1) values.bodyy = clamp((-Math.atan2(lean, height) * degrees) / 2, -10, 10)
  }
  return values
}

/** 取仍在有效期内的样本，过期返回 null。 */
export function currentCameraSample(sample: CameraSample | null, now: number) {
  return sample && now - sample.time < cameraSampleMaxAge ? sample.values : null
}

/** 创建带通道保持的样本缓冲：新值覆盖旧值，超时通道自动淘汰。 */
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

// 不同通道的跟随速度不同：身体角度需要更平滑，眼部/嘴部需要更跟手。
function responseTime(channel: Channel) {
  if (channel.startsWith('body')) return 110
  if (channel === 'eyelopen' || channel === 'eyeropen' || channel === 'mouthopen') return 30
  return 65
}

/**
 * 创建参数驱动函数。
 * 对每个通道做指数平滑并按权重淡入淡出，使摄像头断开时角色平滑回正而非突跳。
 * @param bindings 模型参数名到参数绑定的映射
 * @returns (values, elapsed, apply) => void，按当前样本写入参数
 */
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
    // 影响权重随时间增长，用于首次出现和消失时的渐进过渡。
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
