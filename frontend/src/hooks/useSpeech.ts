/**
 * 文件职责：语音输入与朗读 Hook。
 * 支持 browser（Web Speech / 系统语音）、api（OpenAI 兼容语音服务）与 off 三种模式，
 * 并统一管理麦克风、录音器、音频播放与 AbortController 的清理。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { notify, useStudio } from '../store/studio'

// 以下类型描述 Web Speech API 的最小可用子集，避免依赖浏览器的实验性类型声明。
interface RecognitionResult {
  results: { [index: number]: { [index: number]: { transcript: string } } }
}
interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: RecognitionResult) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
  start(): void
  abort(): void
}
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition
  webkitSpeechRecognition?: new () => Recognition
}

/**
 * @param onTranscript 识别出的文本（会追加到输入框）
 * @param onInterrupt 开始录音前打断正在进行的生成
 * @returns listening 是否正在录音；toggleListening 切换录音；
 *          speak 朗读文本；stopSpeaking 立即停止朗读
 */
export function useSpeech(onTranscript: (text: string) => void, onInterrupt: () => void) {
  const [listening, setListening] = useState(false)
  const recorder = useRef<MediaRecorder | null>(null)
  const recognition = useRef<Recognition | null>(null)
  const tracks = useRef<MediaStream | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const audioURL = useRef('')
  const request = useRef<AbortController | null>(null)
  // mounted 防止异步回调在组件卸载后更新状态。
  const mounted = useRef(true)
  const latestTranscript = useRef(onTranscript)
  latestTranscript.current = onTranscript
  // 停止一切朗读：取消合成请求、取消系统朗读、暂停音频并释放 Blob URL。
  const stopSpeaking = useCallback(() => {
    request.current?.abort()
    request.current = null
    window.speechSynthesis?.cancel()
    audio.current?.pause()
    audio.current = null
    if (audioURL.current) {
      URL.revokeObjectURL(audioURL.current)
      audioURL.current = ''
    }
    useStudio.setState({ speaking: false })
  }, [])
  const speak = useCallback(
    async (text: string) => {
      stopSpeaking()
      const { settings } = useStudio.getState()
      if (!settings || settings.speech.mode === 'off' || !text.trim()) return
      // 去掉代码块与 Markdown 标记，避免朗读出无意义的符号。
      const clean = text
        .replace(/```[\s\S]*?```/g, '代码见聊天记录。')
        .replace(/[*#_`~]/g, '')
        .slice(0, 10000)
      if (settings.speech.mode === 'browser') {
        if (!window.speechSynthesis) {
          notify('当前环境不支持系统朗读，可在设置中使用语音 API。')
          return
        }
        const utterance = new SpeechSynthesisUtterance(clean)
        utterance.lang = settings.speech.language
        // speaking 状态用于驱动 Live2D 口型动画。
        utterance.onstart = () => useStudio.setState({ speaking: true })
        utterance.onend = () => useStudio.setState({ speaking: false })
        utterance.onerror = (e) => {
          useStudio.setState({ speaking: false })
          // 用户主动打断会触发 canceled/interrupted，无需提示。
          if (e.error !== 'canceled' && e.error !== 'interrupted')
            notify('系统朗读不可用，请检查系统语音或配置语音 API。')
        }
        window.speechSynthesis.speak(utterance)
      } else {
        const controller = new AbortController()
        request.current = controller
        try {
          const blob = await api.synthesize(clean, controller.signal)
          if (controller.signal.aborted) return
          audioURL.current = URL.createObjectURL(blob)
          const player = new Audio(audioURL.current)
          audio.current = player
          player.onended = stopSpeaking
          player.onerror = () => {
            stopSpeaking()
            notify('音频播放失败。')
          }
          await player.play()
          useStudio.setState({ speaking: true })
        } catch {
          if (!controller.signal.aborted) {
            stopSpeaking()
            notify('语音合成失败，请检查语音设置。')
          }
        }
      }
    },
    [stopSpeaking],
  )
  const toggleListening = useCallback(async () => {
    // 再次点击：停止录音或取消系统识别。
    if (listening) {
      if (recorder.current?.state === 'recording') recorder.current.stop()
      recognition.current?.abort()
      setListening(false)
      return
    }
    // 开始录音前先打断生成与朗读，避免同时占用音频。
    onInterrupt()
    stopSpeaking()
    const cfg = useStudio.getState().settings?.speech
    if (!cfg || cfg.mode === 'off') {
      notify('请先在设置中启用语音。')
      return
    }
    if (cfg.mode === 'browser') {
      const win = window as SpeechWindow
      const Constructor = win.SpeechRecognition || win.webkitSpeechRecognition
      if (!Constructor) {
        notify('当前 WebView 不支持系统语音识别，请在设置中选择语音 API。')
        return
      }
      const rec = new Constructor()
      recognition.current = rec
      rec.lang = cfg.language
      rec.continuous = false
      rec.interimResults = false
      rec.onresult = (e) => {
        const text = e.results[0][0].transcript
        setListening(false)
        latestTranscript.current(text)
      }
      rec.onend = () => {
        if (mounted.current) setListening(false)
      }
      rec.onerror = (e) => {
        setListening(false)
        if (e.error !== 'aborted') notify('语音识别失败：' + e.error)
      }
      try {
        rec.start()
        setListening(true)
      } catch {
        notify('无法启动系统语音识别。')
      }
    } else {
      try {
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error('麦克风不可用，请使用 localhost 或桌面客户端')
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
        tracks.current = stream
        const media = new MediaRecorder(stream)
        recorder.current = media
        const chunks: BlobPart[] = []
        media.ondataavailable = (e) => {
          if (e.data.size) chunks.push(e.data)
        }
        media.onstop = async () => {
          // 停止时释放麦克风轨道，避免系统麦克风指示灯常亮。
          stream.getTracks().forEach((t) => t.stop())
          tracks.current = null
          if (mounted.current) setListening(false)
          if (!mounted.current || !chunks.length) return
          try {
            const text = await api.transcribe(new Blob(chunks, { type: media.mimeType }))
            if (mounted.current && text.trim()) latestTranscript.current(text)
            else if (mounted.current) notify('没有识别到语音，请重试。')
          } catch {
            if (mounted.current) notify('语音识别失败，请检查语音 API 设置。')
          }
        }
        media.start()
        setListening(true)
      } catch (e) {
        tracks.current?.getTracks().forEach((t) => t.stop())
        tracks.current = null
        notify(e instanceof Error ? e.message : '麦克风启动失败')
      }
    }
  }, [listening, onInterrupt, stopSpeaking])
  // 卸载清理：停止朗读、取消识别、停止录音并释放麦克风。
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      stopSpeaking()
      recognition.current?.abort()
      if (recorder.current?.state === 'recording') recorder.current.stop()
      tracks.current?.getTracks().forEach((t) => t.stop())
    }
  }, [stopSpeaking])
  // 录音最长 60 秒，超时自动结束，防止忘记关闭。
  useEffect(() => {
    if (!listening) return
    const timeout = setTimeout(() => {
      if (recorder.current?.state === 'recording') recorder.current.stop()
      recognition.current?.abort()
      setListening(false)
    }, 60000)
    return () => clearTimeout(timeout)
  }, [listening])
  return { listening, toggleListening, speak, stopSpeaking }
}
