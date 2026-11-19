import { useEffect, useRef, useState } from 'react'
import type { FaceLandmarkerResult } from '@mediapipe/tasks-vision'
import type { openCameraLandmarkers } from '../utils/cameraLandmarkers'
import {
  bodyTrackingValues,
  createCameraSampleBuffer,
  faceTrackingValues,
  type CameraLandmarks,
  type CameraSample,
} from '../utils/cameraTracking'

const cameraMessages = {
  off: '',
  opening: '正在等待摄像头授权…',
  loading: '正在加载本机识别模型…',
  searching: '未检测到人物，请让脸和肩膀进入镜头',
  tracking: '正在跟随 · 摄像头画面不上传',
}

function cameraError(error: unknown, fallback: string) {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return '未获摄像头权限，请在系统或浏览器中允许访问后重试'
      case 'NotFoundError':
        return '未找到摄像头，请连接设备后重试'
      case 'NotReadableError':
      case 'AbortError':
        return '无法打开摄像头，请确认设备未被其他应用占用'
      case 'NotSupportedError':
        return '当前浏览器或 WebView 不支持摄像头跟随，请升级后重试'
    }
  }
  return fallback
}

const stopStream = (stream: MediaStream) => stream.getTracks().forEach((track) => track.stop())

export function useCameraTracking(available: boolean) {
  const [enabled, setEnabled] = useState(false)
  const [status, setStatus] = useState<keyof typeof cameraMessages>('off')
  const [error, setError] = useState('')
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null)
  const sample = useRef<CameraSample | null>(null)
  const landmarks = useRef<CameraLandmarks | null>(null)

  useEffect(() => {
    if (!enabled) return
    if (!available) {
      setEnabled(false)
      return
    }
    const controller = new AbortController()
    const { signal } = controller
    let frame = 0
    let stream: MediaStream | undefined
    let video: HTMLVideoElement | undefined
    let tracker: Awaited<ReturnType<typeof openCameraLandmarkers>> | undefined
    const release = () => {
      if (signal.aborted) return
      controller.abort()
      cancelAnimationFrame(frame)
      sample.current = null
      landmarks.current = null
      if (stream) stopStream(stream)
      setPreviewStream(null)
      if (video) {
        video.pause()
        video.srcObject = null
      }
      tracker?.close()
    }
    const fail = (message: string) => {
      release()
      setError(message)
      setEnabled(false)
    }
    window.addEventListener(
      'pagehide',
      () => {
        release()
        setEnabled(false)
      },
      { signal },
    )

    const start = async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        fail('当前环境无法访问摄像头，请使用桌面应用或从 HTTPS / localhost 打开工作台')
        return
      }
      setStatus('opening')
      let fallback = '摄像头启动失败，请检查设备后重试'
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: 'user',
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 24, max: 30 },
          },
        })
        if (signal.aborted) {
          stopStream(media)
          return
        }
        stream = media
        const tracks = media.getVideoTracks()
        const lostDevice = () => fail('摄像头已断开，请检查设备后重新开启')
        if (!tracks.some((track) => track.readyState === 'live')) {
          lostDevice()
          return
        }
        for (const track of tracks) track.addEventListener('ended', lostDevice, { signal })
        setPreviewStream(media)
        video = document.createElement('video')
        video.muted = true
        video.playsInline = true
        video.srcObject = media
        await video.play()
        if (signal.aborted) return

        setStatus('loading')
        fallback = '本机识别模型加载失败，请检查应用资源或更新浏览器后重试'
        const { openCameraLandmarkers } = await import('../utils/cameraLandmarkers')
        const ready = await openCameraLandmarkers(signal)
        if (signal.aborted) {
          ready.close()
          return
        }
        tracker = ready
        const source = video
        const preview: CameraLandmarks = { width: source.videoWidth, height: source.videoHeight }
        landmarks.current = preview
        const retainSample = createCameraSampleBuffer()
        let lastVideoTime = -1
        let lastFace = -Infinity
        let lastPose = performance.now()
        let face: FaceLandmarkerResult | undefined
        let detecting = false
        setStatus('searching')

        const detect = (now: number) => {
          let updates: CameraSample['values'] | undefined
          if (
            source.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            source.currentTime !== lastVideoTime
          ) {
            try {
              lastVideoTime = source.currentTime
              preview.width = source.videoWidth
              preview.height = source.videoHeight
              if (now - lastPose >= 125) {
                lastPose = now
                const pose = ready.pose.detectForVideo(source, now)
                const points = pose.landmarks[0]
                preview.pose = points?.length ? { time: now, points } : undefined
                updates = bodyTrackingValues(pose, now - lastFace < 200 ? face : undefined)
              } else if (now - lastFace >= 45) {
                lastFace = now
                face = ready.face.detectForVideo(source, now)
                const points = face.faceLandmarks[0]
                preview.face = points?.length ? { time: now, points } : undefined
                updates = faceTrackingValues(face)
              }
            } catch {
              fail('人物识别中断，请重新开启摄像头跟随')
              return
            }
          }
          sample.current = retainSample(now, updates)
          const found = !!sample.current
          if (found !== detecting) {
            detecting = found
            setStatus(found ? 'tracking' : 'searching')
          }
          frame = requestAnimationFrame(detect)
        }
        frame = requestAnimationFrame(detect)
      } catch (cause) {
        if (!signal.aborted) fail(cameraError(cause, fallback))
      }
    }
    void start()
    return release
  }, [available, enabled])

  const toggle = () => {
    setError('')
    setStatus(enabled ? 'off' : 'opening')
    setEnabled(!enabled)
  }
  return {
    enabled,
    error,
    message: error || (enabled ? cameraMessages[status] : ''),
    previewStream: enabled ? previewStream : null,
    landmarks,
    sample,
    toggle,
  }
}
