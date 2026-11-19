/**
 * 页面：透明桌宠窗口（?pet=1）。
 * 展示角色模型、最近回复气泡与精简输入框，并监听跨窗口偏好变更以同步角色。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import * as ContextMenu from '@radix-ui/react-context-menu'
import {
  AlertCircle,
  ArrowUp,
  Check,
  ChevronRight,
  CirclePlus,
  Ellipsis,
  GripHorizontal,
  MessageSquare,
  Pin,
  RotateCcw,
  Smile,
  Sparkles,
  Square,
  Volume2,
  X,
} from 'lucide-react'
import Markdown from 'react-markdown'
import Live2DStage from '../components/Live2DStage'
import type { Live2DCapabilities, Live2DStageHandle } from '../components/Live2DStage'
import { useStudio } from '../store/studio'
import { api } from '../api/client'
import { useChat } from '../hooks/useChat'
import { petRuntime, usePetWindow } from '../hooks/usePetWindow'
import { useSpeech } from '../hooks/useSpeech'
import { actionDisplayName, moodNames } from '../utils/actionNames'

export default function PetPage() {
  const s = useStudio()
  const [text, setText] = useState('')
  const [showChat, setShowChat] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [bubbleHidden, setBubbleHidden] = useState(false)
  const [capabilities, setCapabilities] = useState<Live2DCapabilities>()
  const [actionFeedback, setActionFeedback] = useState<{ text: string }>()
  const [pinned, setPinned] = useState(true)
  const [pinPending, setPinPending] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const openedFromButton = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const focusChatOnClose = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const previousReplyID = useRef<string | undefined>(undefined)
  const stageRef = useRef<Live2DStageHandle>(null)
  // 生成中如果发生角色切换，等本轮结束后再重建会话。
  const resetConversation = useRef(false)
  const [windowError, setWindowError] = useState('')
  const char = s.characters.find((c) => c.id === s.characterID) || s.characters[0]
  const characterName = char?.name || '桌宠'
  const speechAvailable = !!s.settings && s.settings.speech.mode !== 'off'
  const hasMotions = !!capabilities?.ready && capabilities.motions.length > 0
  const hasExpressions =
    !!capabilities?.ready && (capabilities.supportsMoods || capabilities.expressions.length > 0)
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
  const reportAction = useCallback((message: string) => setActionFeedback({ text: message }), [])
  useEffect(() => {
    if (!actionFeedback) return
    const timer = setTimeout(() => setActionFeedback(undefined), 3200)
    return () => clearTimeout(timer)
  }, [actionFeedback])
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
            setText('')
            setActionFeedback(undefined)
            setWindowError('')
            setBubbleHidden(true)
            useStudio.setState({ notice: '' })
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
  const activeReply = s.busy && lastReply?.id === previousReplyID.current ? undefined : lastReply
  const replyText = activeReply?.content
  const tool = activeReply?.tool_runs?.at(-1)
  const error =
    windowError ||
    s.chatError ||
    (!bubbleHidden && !s.busy && lastReply?.status === 'failed'
      ? lastReply.error || '生成失败'
      : '')
  const status = s.busy ? (tool ? '正在使用工具' : '正在回复') : s.speaking ? '正在朗读' : ''
  const showBubble = !!error || (!bubbleHidden && (s.busy || !!replyText))
  const actionText = actionFeedback?.text || s.notice
  const { native: nativeWindow, bubbleSide, dragHandlers, finishDrag } = usePetWindow(showBubble)

  useEffect(() => {
    if (showChat && !focusChatOnClose.current) inputRef.current?.focus()
  }, [showChat])

  function openMenuFromButton(event: ReactMouseEvent<HTMLButtonElement>) {
    openedFromButton.current = true
    const rect = event.currentTarget.getBoundingClientRect()
    event.currentTarget.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left,
        clientY: rect.top,
      }),
    )
  }

  function dismissBubble() {
    setBubbleHidden(true)
    setWindowError('')
    useStudio.setState({ chatError: '' })
  }

  async function togglePinned() {
    if (pinPending) return
    setPinPending(true)
    try {
      const { Window } = await petRuntime()
      await Window.SetAlwaysOnTop(!pinned)
      setPinned(!pinned)
    } catch {
      setWindowError('无法更改桌宠置顶状态')
    } finally {
      setPinPending(false)
    }
  }

  return (
    <ContextMenu.Root modal={false} onOpenChange={setMenuOpen}>
      <ContextMenu.Trigger asChild>
        <main className="pet-page" aria-label={characterName}>
          <div
            className="pet-model"
            data-draggable={nativeWindow}
            {...dragHandlers}
            onPointerUp={(event) => {
              if (finishDrag(event)) void stageRef.current?.playMotion()
            }}
          >
            {char && (
              <Live2DStage
                ref={stageRef}
                modelPath={char.model_path}
                actionNames={char.action_names}
                tapActions={!nativeWindow}
                onCapabilitiesChange={setCapabilities}
                onInteraction={reportAction}
              />
            )}
          </div>
          {showBubble && (
            <section
              className="pet-bubble"
              data-side={bubbleSide}
              data-error={!!error}
              aria-label="桌宠回复"
            >
              <header className="pet-bubble-head">
                <span className="pet-bubble-avatar" aria-hidden="true">
                  {error ? <AlertCircle size={15} /> : Array.from(characterName)[0]}
                </span>
                <strong>{error ? '桌宠提示' : characterName}</strong>
                {!error && status && (
                  <span className="pet-reply-status" role="status">
                    {s.busy ? (
                      <span className="pet-reply-dots" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                    ) : (
                      <Volume2 size={13} />
                    )}
                    {status}
                  </span>
                )}
                <button
                  type="button"
                  className="pet-icon"
                  title="收起气泡"
                  aria-label="收起气泡"
                  onClick={dismissBubble}
                >
                  <X size={15} />
                </button>
              </header>
              {(error || replyText) && (
                <div
                  ref={scrollRef}
                  className="pet-bubble-body"
                  tabIndex={0}
                  role={error ? 'alert' : undefined}
                >
                  {error || (
                    <Markdown
                      components={{
                        a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
                      }}
                      disallowedElements={['img']}
                      unwrapDisallowed
                    >
                      {replyText}
                    </Markdown>
                  )}
                </div>
              )}
            </section>
          )}
          <div className="pet-controls">
            {actionText && (
              <div className="pet-action-notice" role="status" aria-label={actionText}>
                <Sparkles size={15} aria-hidden="true" />
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
                  previousReplyID.current = lastReply?.id
                  scrollRef.current?.scrollTo(0, 0)
                  setBubbleHidden(false)
                  setWindowError('')
                  voice.stopSpeaking()
                  void send(text, '', () => setText((draft) => (draft === text ? '' : draft)))
                }}
              >
                <input
                  ref={inputRef}
                  aria-label="桌宠消息"
                  placeholder={`和${characterName}聊天…`}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onContextMenu={(e) => e.stopPropagation()}
                />
                <button
                  type="submit"
                  className="pet-icon"
                  disabled={!s.busy && !text.trim()}
                  aria-label={s.busy ? '停止生成' : '发送'}
                  title={s.busy ? '停止生成' : '发送'}
                >
                  {s.busy ? <Square size={13} /> : <ArrowUp size={17} />}
                </button>
              </form>
            )}
            <div className="pet-toolbar" role="group" aria-label="桌宠快捷操作">
              <span
                className="pet-drag-handle"
                title="拖动桌宠窗口"
                {...dragHandlers}
                onPointerUp={finishDrag}
              >
                <GripHorizontal size={16} />
              </span>
              <button
                type="button"
                className="pet-icon"
                aria-label={showChat ? '收起聊天' : '打开聊天'}
                aria-pressed={showChat}
                title={showChat ? '收起聊天' : '打开聊天'}
                onClick={() => setShowChat(!showChat)}
              >
                <MessageSquare size={16} />
              </button>
              <button
                type="button"
                className="pet-icon"
                aria-label="随机动作"
                title="随机动作"
                disabled={!hasMotions}
                onClick={() => void stageRef.current?.playMotion()}
              >
                <Sparkles size={16} />
              </button>
              <button
                ref={moreRef}
                type="button"
                className="pet-icon"
                aria-label="桌宠菜单"
                title="桌宠菜单"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={openMenuFromButton}
              >
                <Ellipsis size={19} />
              </button>
            </div>
          </div>
        </main>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="pet-menu"
          aria-label="桌宠菜单"
          collisionPadding={10}
          onCloseAutoFocus={(event) => {
            if (focusChatOnClose.current) {
              event.preventDefault()
              focusChatOnClose.current = false
              inputRef.current?.focus()
            } else if (openedFromButton.current && !event.defaultPrevented) {
              event.preventDefault()
              moreRef.current?.focus()
            }
            openedFromButton.current = false
          }}
        >
          <ContextMenu.Label className="pet-menu-label">{characterName}</ContextMenu.Label>
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
            disabled={s.busy || !char}
            onSelect={() => {
              voice.stopSpeaking()
              s.selectCharacter(s.characterID)
              setText('')
              dismissBubble()
              focusChatOnClose.current = true
              setShowChat(true)
            }}
          >
            <CirclePlus size={16} /> 开始新对话
          </ContextMenu.Item>
          <ContextMenu.Separator className="pet-menu-divider" />
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="pet-menu-item" disabled={!hasMotions}>
              <Sparkles size={16} /> 动作 <ChevronRight size={14} className="pet-menu-end" />
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className="pet-menu pet-submenu" collisionPadding={10}>
                <ContextMenu.Item
                  className="pet-menu-item"
                  onSelect={() => void stageRef.current?.playMotion()}
                >
                  随机动作
                </ContextMenu.Item>
                <ContextMenu.Separator className="pet-menu-divider" />
                {capabilities?.motions.map((motion) => (
                  <ContextMenu.Item
                    key={motion.id}
                    className="pet-menu-item"
                    onSelect={() => void stageRef.current?.playMotion(motion.id)}
                  >
                    {actionDisplayName(char?.action_names, 'motions', motion.id, motion.label)}
                  </ContextMenu.Item>
                ))}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="pet-menu-item" disabled={!hasExpressions}>
              <Smile size={16} /> 表情 <ChevronRight size={14} className="pet-menu-end" />
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className="pet-menu pet-submenu" collisionPadding={10}>
                <ContextMenu.Item
                  className="pet-menu-item"
                  onSelect={() => void stageRef.current?.setExpression(null)}
                >
                  恢复自然
                </ContextMenu.Item>
                {capabilities?.expressions.map((expression) => (
                  <ContextMenu.Item
                    key={expression.id}
                    className="pet-menu-item"
                    onSelect={() => void stageRef.current?.setExpression(expression.id)}
                  >
                    {actionDisplayName(
                      char?.action_names,
                      'expressions',
                      expression.id,
                      expression.label,
                    )}
                  </ContextMenu.Item>
                ))}
                {capabilities?.supportsMoods &&
                  Object.entries(moodNames)
                    .filter(([id]) => id !== 'neutral')
                    .map(([id, label]) => (
                      <ContextMenu.Item
                        key={id}
                        className="pet-menu-item"
                        onSelect={() => stageRef.current?.setMood(id)}
                      >
                        {actionDisplayName(char?.action_names, 'moods', id, label)}
                      </ContextMenu.Item>
                    ))}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Item
            className="pet-menu-item"
            disabled={!capabilities?.ready}
            onSelect={() => {
              s.setMood('neutral')
              stageRef.current?.reset()
              reportAction('已恢复默认动作和表情')
            }}
          >
            <RotateCcw size={16} /> 重置动作和表情
          </ContextMenu.Item>
          <ContextMenu.Separator className="pet-menu-divider" />
          <ContextMenu.CheckboxItem
            className="pet-menu-item"
            checked={s.speechEnabled}
            disabled={!speechAvailable}
            onCheckedChange={(enabled) => {
              s.patch({ speechEnabled: enabled })
              if (!enabled) voice.stopSpeaking()
            }}
          >
            <Volume2 size={16} /> 自动朗读
            <ContextMenu.ItemIndicator className="pet-menu-end">
              <Check size={14} />
            </ContextMenu.ItemIndicator>
          </ContextMenu.CheckboxItem>
          <ContextMenu.Item
            className="pet-menu-item"
            disabled={!speechAvailable || s.busy || (!replyText && !s.speaking)}
            onSelect={() => {
              if (s.speaking) voice.stopSpeaking()
              else if (replyText) void voice.speak(replyText)
            }}
          >
            {s.speaking ? <Square size={16} /> : <Volume2 size={16} />}
            {s.speaking ? '停止朗读' : '朗读最近回复'}
          </ContextMenu.Item>
          <ContextMenu.Separator className="pet-menu-divider" />
          {nativeWindow && (
            <ContextMenu.CheckboxItem
              className="pet-menu-item"
              checked={pinned}
              disabled={pinPending}
              onCheckedChange={() => void togglePinned()}
            >
              <Pin size={16} /> 窗口置顶
              <ContextMenu.ItemIndicator className="pet-menu-end">
                <Check size={14} />
              </ContextMenu.ItemIndicator>
            </ContextMenu.CheckboxItem>
          )}
          <ContextMenu.Item
            className="pet-menu-item pet-menu-close"
            onSelect={() => {
              stop()
              voice.stopSpeaking()
              void api.window('pet', false).catch((cause: Error) => setWindowError(cause.message))
            }}
          >
            <X size={16} /> 关闭桌宠
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
