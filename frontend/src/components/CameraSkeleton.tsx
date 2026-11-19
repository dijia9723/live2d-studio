import { useEffect, useRef, type RefObject } from 'react'
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import {
  cameraSampleMaxAge,
  isVisiblePoseLandmark,
  type CameraLandmarks,
} from '../utils/cameraTracking'

// MediaPipe Pose indices for the torso, arms, hands, legs, and feet.
const bones = [
  [11, 12],
  [11, 23],
  [12, 24],
  [23, 24],
  [11, 13],
  [13, 15],
  [15, 17],
  [15, 19],
  [15, 21],
  [17, 19],
  [12, 14],
  [14, 16],
  [16, 18],
  [16, 20],
  [16, 22],
  [18, 20],
  [23, 25],
  [25, 27],
  [27, 29],
  [27, 31],
  [29, 31],
  [24, 26],
  [26, 28],
  [28, 30],
  [28, 32],
  [30, 32],
]

function drawSkeleton(
  context: CanvasRenderingContext2D,
  face: NormalizedLandmark[],
  pose: NormalizedLandmark[],
) {
  const { width, height } = context.canvas
  const scale = Math.min(width, height) / 480
  context.clearRect(0, 0, width, height)
  context.lineWidth = 3 * scale
  context.lineCap = 'round'
  context.strokeStyle = '#bda2fa'
  context.beginPath()
  for (const [start, end] of bones) {
    const a = pose[start]
    const b = pose[end]
    if (!isVisiblePoseLandmark(a) || !isVisiblePoseLandmark(b)) continue
    context.moveTo(a.x * width, a.y * height)
    context.lineTo(b.x * width, b.y * height)
  }
  context.stroke()

  context.fillStyle = '#e0cdff'
  context.beginPath()
  const jointRadius = 4 * scale
  for (const joint of pose.slice(11)) {
    if (!isVisiblePoseLandmark(joint)) continue
    const x = joint.x * width
    const y = joint.y * height
    context.moveTo(x + jointRadius, y)
    context.arc(x, y, jointRadius, 0, 2 * Math.PI)
  }
  context.fill()

  context.fillStyle = '#d7c0fa'
  context.beginPath()
  const facePointRadius = 1.4 * scale
  for (const point of face) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
    const x = point.x * width
    const y = point.y * height
    context.moveTo(x + facePointRadius, y)
    context.arc(x, y, facePointRadius, 0, 2 * Math.PI)
  }
  context.fill()
}

export default function CameraSkeleton({
  landmarks,
}: {
  landmarks: RefObject<CameraLandmarks | null>
}) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const target = canvas.current
    const context = target?.getContext('2d')
    if (!target || !context) return

    let animationFrame = 0
    let lastFace: NormalizedLandmark[] | undefined
    let lastPose: NormalizedLandmark[] | undefined
    const render = (now: number) => {
      const preview = landmarks.current
      const face =
        preview?.face && now - preview.face.time < cameraSampleMaxAge
          ? preview.face.points
          : undefined
      const pose =
        preview?.pose && now - preview.pose.time < cameraSampleMaxAge
          ? preview.pose.points
          : undefined
      const resized =
        preview &&
        preview.width > 0 &&
        preview.height > 0 &&
        (target.width !== preview.width || target.height !== preview.height)
      if (resized) {
        target.width = preview.width
        target.height = preview.height
      }
      if (resized || face !== lastFace || pose !== lastPose) {
        drawSkeleton(context, face ?? [], pose ?? [])
        lastFace = face
        lastPose = pose
      }
      animationFrame = requestAnimationFrame(render)
    }
    animationFrame = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animationFrame)
  }, [landmarks])

  return <canvas ref={canvas} role="img" aria-label="摄像头骨骼镜像预览" />
}
