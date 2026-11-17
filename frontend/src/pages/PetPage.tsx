/**
 * 页面：透明桌宠窗口（?pet=1）。
 * 展示角色模型、最近回复气泡与精简输入框，并监听跨窗口偏好变更以同步角色。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, GripHorizontal, Square, Volume2, VolumeX, X } from 'lucide-react'
import Live2DStage from '../components/Live2DStage'
import { useStudio } from '../store/studio'
import { api } from '../api/client'
import { useChat } from '../hooks/useChat'
import { useSpeech } from '../hooks/useSpeech'

export default function PetPage() {
  const s = useStudio()
  const [text, setText] = useState('')
  // 生成中如果发生角色切换，等本轮结束后再重建会话。
  const resetConversation = useRef(false)
  const [windowError, setWindowError] = useState('')
  const char = s.characters.find((c) => c.id === s.characterID) || s.characters[0]
  const transcript = useCallback((t: string) => setText(t), [])
  const interrupt = useCallback(() => {}, [])
  const voice = useSpeech(transcript, interrupt)
  const reply = useCallback(
    (value: string) => {
      if (useStudio.getState().speechEnabled) void voice.speak(value)
    },
    [voice.speak],
  )
  const { send, stop } = useChat(reply)
  // 桌宠窗口使用独立的 document 样式类，避免影响主窗口。
  useEffect(() => {
    document.documentElement.classList.add('pet-document')
    return () => document.documentElement.classList.remove('pet-document')
  }, [])
  // 主窗口修改了持久化偏好时，重新水合状态并同步角色切换。
  useEffect(() => {
    const sync = (e: StorageEvent) => {
      if (e.key === 'live2d-studio-preferences') {
        const before = useStudio.getState().characterID
        void Promise.resolve(useStudio.persist.rehydrate()).then(() => {
          const state = useStudio.getState()
          if (state.characterID !== before) {
            stop()
            voice.stopSpeaking()
            if (state.busy) resetConversation.current = true
            else state.selectCharacter(state.characterID)
          }
        })
      }
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [stop, voice.stopSpeaking])
  // 生成结束后补做此前被推迟的会话重置。
  useEffect(() => {
    if (!s.busy && resetConversation.current) {
      resetConversation.current = false
      s.selectCharacter(s.characterID)
    }
  }, [s.busy, s.characterID, s.selectCharacter])
  const latestMessage = s.messages.at(-1)
  const lastReply = latestMessage?.role === 'assistant' ? latestMessage : undefined
  const tool = lastReply?.tool_runs?.at(-1)
  const error =
    windowError ||
    s.chatError ||
    (!s.busy && lastReply?.status === 'failed' ? lastReply.error || '生成失败' : '')
  // 气泡内容优先级：错误 > 最近回复 > 生成中的状态提示。
  const bubble =
    error || lastReply?.content || (s.busy ? (tool ? '正在使用工具…' : '正在生成回复…') : '')
  return (
    <div className="pet-page">
      <div className="pet-toolbar">
        <span className="pet-drag" style={{ '--wails-draggable': 'drag' } as React.CSSProperties}>
          <GripHorizontal size={17} />
          {char?.name}
        </span>
        <button
          title="关闭桌宠"
          aria-label="关闭桌宠"
          onClick={() => {
            stop()
            voice.stopSpeaking()
            void api.window('pet', false).catch((cause: Error) => setWindowError(cause.message))
          }}
        >
          <X size={17} />
        </button>
      </div>
      {bubble && (
        <div
          className={`pet-bubble ${error ? 'pet-error' : ''}`}
          role={error ? 'alert' : undefined}
        >
          {bubble}
        </div>
      )}
      <div className="pet-model">{char && <Live2DStage modelPath={char.model_path} />}</div>
      <form
        className="pet-composer"
        onSubmit={(e) => {
          e.preventDefault()
          if (s.busy) {
            stop()
            voice.stopSpeaking()
            return
          }
          if (!text.trim()) return
          setWindowError('')
          voice.stopSpeaking()
          void send(text, '', () => setText((draft) => (draft === text ? '' : draft)))
        }}
      >
        <button
          type="button"
          className="pet-speech"
          aria-label="自动朗读"
          aria-pressed={s.speechEnabled}
          title={s.speechEnabled ? '关闭自动朗读' : '开启自动朗读'}
          disabled={s.settings?.speech.mode === 'off'}
          onClick={() => {
            s.patch({ speechEnabled: !s.speechEnabled })
            voice.stopSpeaking()
          }}
        >
          {s.speechEnabled ? <Volume2 size={17} /> : <VolumeX size={17} />}
        </button>
        <input
          aria-label="桌宠消息"
          placeholder="输入消息…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="submit"
          disabled={!s.busy && !text.trim()}
          aria-label={s.busy ? '停止生成' : '发送'}
        >
          {s.busy ? <Square size={13} /> : <ArrowUp size={17} />}
        </button>
      </form>
    </div>
  )
}
