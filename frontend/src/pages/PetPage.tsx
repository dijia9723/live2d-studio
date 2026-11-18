/**
 * 页面：透明桌宠窗口（?pet=1）。
 * 展示角色模型、最近回复气泡与精简输入框，并监听跨窗口偏好变更以同步角色。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { ArrowUp, MessageSquare, Square, Volume2, VolumeX, X } from 'lucide-react'
import Live2DStage from '../components/Live2DStage'
import type { Live2DStageHandle } from '../components/Live2DStage'
import { useStudio } from '../store/studio'
import { api } from '../api/client'
import { useChat } from '../hooks/useChat'
import { useSpeech } from '../hooks/useSpeech'

export default function PetPage() {
  const s = useStudio()
  const [text, setText] = useState('')
  const [showChat, setShowChat] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const focusChatOnClose = useRef(false)
  const stageRef = useRef<Live2DStageHandle>(null)
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
  const { send, stop } = useChat(reply, stageRef)
  useEffect(() => {
    if (!s.notice) return
    const timer = setTimeout(() => useStudio.getState().patch({ notice: '' }), 5000)
    return () => clearTimeout(timer)
  }, [s.notice])
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
      <ContextMenu.Root modal={false}>
        <ContextMenu.Trigger asChild>
          <div className="pet-model" tabIndex={0} aria-label={char?.name || '桌宠'}>
            {char && (
              <Live2DStage
                ref={stageRef}
                modelPath={char.model_path}
                actionNames={char.action_names}
              />
            )}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            className="pet-menu"
            collisionPadding={8}
            onCloseAutoFocus={(event) => {
              if (!focusChatOnClose.current) return
              focusChatOnClose.current = false
              event.preventDefault()
              inputRef.current?.focus()
            }}
          >
            <ContextMenu.Item
              className="pet-menu-item"
              onSelect={() => {
                focusChatOnClose.current = !showChat
                setShowChat(!showChat)
              }}
            >
              <MessageSquare size={16} />
              {showChat ? '收起聊天' : '打开聊天'}
            </ContextMenu.Item>
            <ContextMenu.Item
              className="pet-menu-item"
              disabled={s.settings?.speech.mode === 'off'}
              onSelect={() => {
                s.patch({ speechEnabled: !s.speechEnabled })
                voice.stopSpeaking()
              }}
            >
              {s.speechEnabled ? <VolumeX size={16} /> : <Volume2 size={16} />}
              {s.speechEnabled ? '关闭自动朗读' : '开启自动朗读'}
            </ContextMenu.Item>
            <ContextMenu.Separator className="pet-menu-divider" />
            <ContextMenu.Item
              className="pet-menu-item"
              onSelect={() => {
                stop()
                voice.stopSpeaking()
                void api.window('pet', false).catch((cause: Error) => setWindowError(cause.message))
              }}
            >
              <X size={16} />
              关闭桌宠
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {(showChat || error) && bubble && (
        <div
          className={`pet-bubble ${error ? 'pet-error' : ''}`}
          role={error ? 'alert' : undefined}
        >
          {bubble}
        </div>
      )}
      {s.notice && (
        <div className="pet-action-notice" role="status">
          {s.notice}
        </div>
      )}
      {showChat && (
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
          <input
            ref={inputRef}
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
      )}
    </div>
  )
}
