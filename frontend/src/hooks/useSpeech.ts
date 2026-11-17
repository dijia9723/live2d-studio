import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { notify, useStudio } from '../store/studio'

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

export function useSpeech(onTranscript: (text: string) => void, onInterrupt: () => void) {
  const [listening, setListening] = useState(false)
  const recorder = useRef<MediaRecorder | null>(null)
  const recognition = useRef<Recognition | null>(null)
  const tracks = useRef<MediaStream | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const audioURL = useRef('')
  const request = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const latestTranscript = useRef(onTranscript)
  latestTranscript.current = onTranscript
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
      const { speechEnabled, settings } = useStudio.getState()
      if (!speechEnabled || !settings || settings.speech.mode === 'off' || !text.trim()) return
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
        utterance.onstart = () => useStudio.setState({ speaking: true })
        utterance.onend = () => useStudio.setState({ speaking: false })
        utterance.onerror = (e) => {
          useStudio.setState({ speaking: false })
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
    if (listening) {
      if (recorder.current?.state === 'recording') recorder.current.stop()
      recognition.current?.abort()
      setListening(false)
      return
    }
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
