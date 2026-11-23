import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { baseURL, http } from '../api/client'

const mimeType = 'video/webm;codecs=vp8,opus'
const targetFactory = () =>
  (
    window as Window & {
      RestrictionTarget?: { fromElement(element: Element): Promise<object> }
    }
  ).RestrictionTarget

type DisplayTrack = MediaStreamTrack & { restrictTo?: (target: object) => Promise<void> }
type SourceURLs = { rtsp: string; rtmp: string; hls: string }
type OutputMessage = ({ type: 'ready' } & SourceURLs) | { type: 'error'; message: string }
type OutputState =
  | { phase: 'idle' | 'starting' }
  | { phase: 'error'; message: string }
  | { phase: 'live'; sources: SourceURLs }

interface Capture {
  streams: MediaStream[]
  mixer?: AudioContext
  socket?: WebSocket
  recorder?: MediaRecorder
  timeout?: ReturnType<typeof setTimeout>
}

export async function outputDependencies(signal: AbortSignal) {
  const result = (
    await http.get<{ data: { missing: string[]; busy: boolean } }>('/stage-output', { signal })
  ).data.data
  if (!Array.isArray(result?.missing)) throw new Error('画布输出服务未响应')
  return result
}

export const outputBrowserURL = () => new URL('/', new URL(baseURL, window.location.href)).href

function closeCapture(capture: Capture | null) {
  if (!capture) return
  clearTimeout(capture.timeout)
  if (capture.recorder && capture.recorder.state !== 'inactive') capture.recorder.stop()
  capture.socket?.close()
  for (const stream of capture.streams) for (const track of stream.getTracks()) track.stop()
  if (capture.mixer) void capture.mixer.close().catch(() => {})
}

function outputSocket(element: HTMLElement) {
  const { width, height } = element.getBoundingClientRect()
  if (width < 16 || height < 16) throw new Error('画布尺寸过小，请放大工作台后重试。')
  const scale = Math.min(window.devicePixelRatio, 1920 / Math.max(width, height))
  const even = (size: number) => Math.max(16, Math.floor((size * scale) / 2) * 2)
  const url = new URL(`${baseURL}/stage-output/stream`, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.search = new URLSearchParams({
    width: String(even(width)),
    height: String(even(height)),
  }).toString()
  return new WebSocket(url)
}

export function useStageOutput(target: RefObject<HTMLDivElement | null>) {
  const [state, setState] = useState<OutputState>({ phase: 'idle' })
  const active = useRef<Capture | null>(null)
  const supported =
    window.location.origin === new URL(baseURL, window.location.href).origin &&
    !!targetFactory() &&
    !!navigator.mediaDevices?.getDisplayMedia &&
    typeof MediaRecorder !== 'undefined' &&
    MediaRecorder.isTypeSupported(mimeType)

  const stop = useCallback(() => {
    const old = active.current
    active.current = null
    closeCapture(old)
    setState({ phase: 'idle' })
  }, [])

  useEffect(() => {
    // 离开工作台或关闭页面时断开流，并释放本次授权的采集轨道。
    window.addEventListener('pagehide', stop)
    return () => {
      window.removeEventListener('pagehide', stop)
      const old = active.current
      active.current = null
      closeCapture(old)
    }
  }, [stop])

  const start = async (includeMicrophone: boolean) => {
    const element = target.current
    const factory = targetFactory()
    if (!supported || !element || !factory || active.current) return
    const capture: Capture = { streams: [] }
    active.current = capture
    const current = () => active.current === capture
    const fail = (message: string) => {
      if (!current()) return
      stop()
      setState({ phase: 'error', message })
    }
    const keepStream = (stream: MediaStream) => {
      if (!current()) {
        stream.getTracks().forEach((track) => track.stop())
        return false
      }
      capture.streams.push(stream)
      return true
    }
    setState({ phase: 'starting' })
    try {
      // getDisplayMedia 必须在用户点击后的同一轮调用，先让浏览器显示授权选择。
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 }, displaySurface: 'browser' },
        audio: true,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
        systemAudio: 'exclude',
        monitorTypeSurfaces: 'exclude',
      } as DisplayMediaStreamOptions)
      if (!keepStream(display)) return
      const video = display.getVideoTracks()[0] as DisplayTrack | undefined
      if (!video?.restrictTo || video.getSettings().displaySurface !== 'browser')
        throw new Error('请选择当前 Live2D Studio 标签页，并开启标签页音频。')
      try {
        await video.restrictTo(await factory.fromElement(element))
      } catch {
        throw new Error('无法限定到舞台画布，请重新共享当前 Live2D Studio 标签页。')
      }
      if (!current()) return
      let audio = display.getAudioTracks()[0]
      if (!audio) throw new Error('标签页音频未共享。请重新开始，并勾选「同时分享标签页音频」。')
      video.addEventListener('ended', () => fail('标签页共享已结束。'), { once: true })
      audio.addEventListener('ended', () => fail('标签页音频共享已结束。'), { once: true })
      if (includeMicrophone) {
        const mixer = new AudioContext()
        capture.mixer = mixer
        const microphone = await navigator.mediaDevices
          .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
          .catch(() => {
            throw new Error('麦克风不可用，请检查浏览器权限，或关闭麦克风后重试。')
          })
        if (!keepStream(microphone)) return
        microphone
          .getAudioTracks()[0]
          ?.addEventListener('ended', () => fail('麦克风共享已结束。'), { once: true })
        const mix = mixer.createMediaStreamDestination()
        const limiter = mixer.createDynamicsCompressor()
        limiter.connect(mix)
        mixer.createMediaStreamSource(new MediaStream([audio])).connect(limiter)
        mixer.createMediaStreamSource(microphone).connect(limiter)
        await mixer.resume()
        if (!keepStream(mix.stream)) return
        audio = mix.stream.getAudioTracks()[0]
      }
      if (!current()) return
      const socket = outputSocket(element)
      capture.socket = socket
      capture.timeout = setTimeout(() => fail('画布输出启动超时，请检查本机转码服务。'), 28_000)
      const recorder = new MediaRecorder(new MediaStream([video, audio]), {
        mimeType,
        videoBitsPerSecond: 3_500_000,
        audioBitsPerSecond: 128_000,
      })
      capture.recorder = recorder
      recorder.ondataavailable = ({ data }) => {
        if (!current() || !data.size || socket.readyState !== WebSocket.OPEN) return
        if (socket.bufferedAmount + data.size > 8 * 1024 * 1024) {
          fail('音视频积压过多，已停止输出。请减小画布或关闭占用较高的程序后重试。')
          return
        }
        for (let offset = 0; offset < data.size; offset += 3 * 1024 * 1024)
          socket.send(data.slice(offset, offset + 3 * 1024 * 1024))
      }
      recorder.onerror = () => fail('浏览器录制中断，请重新共享标签页。')
      socket.onopen = () => {
        if (!current()) return
        try {
          recorder.start(250)
        } catch {
          fail('浏览器无法录制舞台音视频，请重新共享标签页。')
        }
      }
      socket.onmessage = ({ data }) => {
        if (!current()) return
        const message = JSON.parse(data) as OutputMessage
        if (message.type === 'error') fail(message.message)
        if (message.type === 'ready') {
          clearTimeout(capture.timeout)
          setState({ phase: 'live', sources: message })
        }
      }
      socket.onerror = () => fail('无法连接本机画布输出服务。')
      socket.onclose = () => fail('画布输出连接已断开。')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotAllowedError')
        fail('未获得标签页共享权限。')
      else if (error instanceof DOMException && error.name === 'NotReadableError')
        fail('浏览器无法读取所选标签页，请保持工作台标签页打开后重试。')
      else fail(error instanceof Error ? error.message : '无法启动画布输出。')
    }
  }

  return { state, start, stop, supported }
}
