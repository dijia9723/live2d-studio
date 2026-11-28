/**
 * 文件职责：摄像头跟随 Hook。
 * 负责申请摄像头、动态加载 MediaPipe 面部/身体模型、按帧率节流检测，
 * 并把归一化关键点和参数样本暴露给预览与角色渲染；画面只在本机处理。
 */
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

// 各状态对应的提示文案，error 优先于这里的 message。
const cameraMessages = {
  off: '',
  opening: '正在等待摄像头授权…',
  loading: '正在加载本机识别模型…',
  searching: '未检测到人物，请让脸和肩膀进入镜头',
  tracking: '正在跟随 · 摄像头画面不上传',
}

// 浏览器抛出的 DOMException 名称对用户不友好，统一映射为可操作的提示。
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

// 无论停止原因如何，都停掉轨道，避免摄像头指示灯常亮。
const stopStream = (stream: MediaStream) => stream.getTracks().forEach((track) => track.stop())

/**
 * 管理摄像头跟随的开关与运行态。
 * @param available 舞台是否允许使用摄像头（如当前角色/页面支持）
 * @returns enabled：是否开启；message：当前提示；previewStream：预览流；
 *          landmarks/sample：供预览与参数驱动的实时引用；toggle：切换开关
 */
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
    // release 必须可重复调用：出错、页面隐藏、effect 清理都会走到这里。
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
    // 桌面端切到后台/关闭时浏览器不一定触发卸载，用 pagehide 主动释放设备。
    window.addEventListener(
      'pagehide',
      () => {
        release()
        setEnabled(false)
      },
      { signal },
    )

    const start = async () => {
      // getUserMedia 只在安全上下文可用；WebView 需由桌面端注入或走 localhost。
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
        // 设备在授权后仍可能被拔掉或被占用，靠轨道的 ended 事件收敛状态。
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
        // MediaPipe 体积较大，按需动态加载，未开启摄像头时不占用首屏资源。
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
          // 同一帧视频只检测一次，避免高刷屏重复跑推理。
          if (
            source.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            source.currentTime !== lastVideoTime
          ) {
            try {
              lastVideoTime = source.currentTime
              preview.width = source.videoWidth
              preview.height = source.videoHeight
              // 身体姿态更新较慢（~8fps），面部更频繁（~22fps），用时间片交替执行以控制 CPU 占用。
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
          // 样本缓冲会保留短暂缺席的通道，避免某一帧漏检导致参数瞬间回弹。
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

  // 切换时先清空上一轮错误，关闭则立即给出“已关闭”状态。
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
