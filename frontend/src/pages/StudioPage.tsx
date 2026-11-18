/**
 * 页面：AI 对话主工作台，组合 Live2D 舞台、消息列表与输入区。
 * 左侧显示角色舞台，右侧切换对话、舞台设置与摄像头预览。
 * 同时管理草稿、图片附件、自动滚动、语音输入与朗读、历史导出等交互。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import Markdown from 'react-markdown'
import {
  ArrowDownToLine,
  ArrowDown,
  ArrowUpRight,
  Brain,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Cpu,
  ImagePlus,
  Layers,
  Maximize2,
  Mic,
  MessageCircle,
  Minus,
  MoreHorizontal,
  Pin,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  Sparkles,
  Square,
  Video,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import Live2DStage from '../components/Live2DStage'
import CharacterMemories from '../components/CharacterMemories'
import MessageToolRuns from '../components/MessageToolRuns'
import type { Live2DCapabilities, Live2DStageHandle } from '../components/Live2DStage'
import StageSettingsPanel from '../components/StageSettingsPanel'
import StageBackground from '../components/StageBackground'
import StageEffects from '../components/StageEffects'
import StageOverlay from '../components/StageOverlay'
import CanvasLayer from '../components/CanvasLayer'
import CanvasToolbar from '../components/CanvasToolbar'
import StageViewToolbar from '../components/StageViewToolbar'
import CameraPanel from '../components/CameraPanel'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import { useStudio, notify } from '../store/studio'
import { draftKey, emptyDraft, updateDraft, useChatDrafts } from '../store/chatDrafts'
import { useChat } from '../hooks/useChat'
import { useCameraTracking } from '../hooks/useCameraTracking'
import { useStageFrame } from '../hooks/useStageFrame'
import { useSpeech } from '../hooks/useSpeech'
import { api } from '../api/client'
import { download } from '../utils/format'

const messageLimit = 32000
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long' })
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' })
const promptSuggestions = ['陪我聊聊今天', '给我一个放松的小建议', '你记得我哪些偏好？']
const workspacePanels = [
  { id: 'chat', label: '对话', icon: MessageCircle },
  { id: 'stage', label: '舞台设置', icon: Layers },
  { id: 'camera', label: '摄像头', icon: Video },
] as const
type WorkspacePanel = (typeof workspacePanels)[number]['id']

export default function StudioPage() {
  const s = useStudio()
  const navigate = useNavigate()
  const character = s.characters.find((c) => c.id === s.characterID) || s.characters[0]
  const camera = useCameraTracking(!!character)
  const draftID = draftKey(s.conversationID, s.characterID)
  const { text, image } = useChatDrafts((drafts) => drafts[draftID] ?? emptyDraft)
  const setText = useCallback(
    (value: string) => {
      updateDraft(draftID, (draft) => ({ ...draft, text: value }))
    },
    [draftID],
  )
  const [pinned, setPinned] = useState(false)
  const [copied, setCopied] = useState('')
  const [memoryDialog, setMemoryDialog] = useState<{ initialDraft?: string } | null>(null)
  const transcriptScroll = useRef<HTMLDivElement>(null)
  const stickToLatest = useRef(true)
  const [atLatest, setAtLatest] = useState(true)
  const composer = useRef<HTMLTextAreaElement>(null)
  const upload = useRef<HTMLInputElement>(null)
  const imageReader = useRef<FileReader | null>(null)
  const stageFrame = useStageFrame(s.aspect, !!character)
  const container = stageFrame.ref
  const dock = useRef<HTMLElement>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const stageRef = useRef<Live2DStageHandle>(null)
  const [capabilities, setCapabilities] = useState<Live2DCapabilities | null>(null)
  const [interaction, setInteraction] = useState('')
  const [rightPanel, setRightPanel] = useState<WorkspacePanel>('chat')
  const [stageCategory, setStageCategory] = useState('character')
  const inspectCanvas = useCallback(() => {
    setRightPanel('stage')
    setStageCategory('widgets')
  }, [])
  useEffect(() => {
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey)
        return
      const target = event.target as HTMLElement | null
      if (
        target?.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]',
        )
      )
        return
      if (document.querySelector('[role="dialog"]')) return
      if (event.key.toLowerCase() === 'h') {
        event.preventDefault()
        const state = useStudio.getState()
        state.patch({ controlsVisible: !state.controlsVisible })
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])
  const background = s.sceneAssets.find((item) => item.id === s.backgroundAssetID)
  const activeEffects =
    s.effects.filter((effect) => effect.enabled).length + (s.overlayAssetID ? 1 : 0)
  const draftTooLong = useMemo(() => new TextEncoder().encode(text).length > messageLimit, [text])
  const speechAvailable = !!s.settings && s.settings.speech.mode !== 'off'
  // stopRef 让 interrupt 回调始终指向最新的 chat.stop，避免 Hook 依赖循环。
  const stopRef = useRef<() => void>(() => {})
  // 语音识别结果追加到当前草稿，而不是覆盖已有输入。
  const transcript = useCallback(
    (t: string) => {
      updateDraft(draftID, (draft) => ({ ...draft, text: draft.text ? draft.text + '\n' + t : t }))
      composer.current?.focus()
    },
    [draftID],
  )
  const interrupt = useCallback(() => stopRef.current(), [])
  const voice = useSpeech(transcript, interrupt)
  const activity = voice.listening ? '正在录音' : s.busy ? '正在生成' : s.speaking ? '正在朗读' : ''
  const reply = useCallback(
    (t: string) => {
      if (useStudio.getState().speechEnabled) void voice.speak(t)
    },
    [voice.speak],
  )
  const chat = useChat(reply, stageRef)
  useEffect(() => setInteraction(''), [character?.model_path])
  stopRef.current = chat.stop
  // 切换会话时回到“跟随最新消息”的滚动模式。
  useEffect(() => {
    stickToLatest.current = true
    setAtLatest(true)
  }, [s.conversationID])
  // 新消息到达且用户仍停留在底部时自动滚到底部。
  useEffect(() => {
    const list = transcriptScroll.current
    if (rightPanel === 'chat' && list && stickToLatest.current) list.scrollTop = list.scrollHeight
  }, [s.messages, rightPanel, s.conversationID])
  // 卸载时清理“已复制”状态的计时器。
  useEffect(() => () => clearTimeout(copyTimer.current), [])
  const scrollToLatest = () => {
    stickToLatest.current = true
    setAtLatest(true)
    const list = transcriptScroll.current
    if (list) list.scrollTop = list.scrollHeight
  }
  // 发送前停止朗读；消息被服务端接收后再清空对应草稿，避免失败时丢失输入。
  const send = async () => {
    if (!text.trim() || draftTooLong || s.busy) return
    voice.stopSpeaking()
    scrollToLatest()
    await chat.send(text, image, (conversationID) => {
      updateDraft(conversationID, (draft) => ({
        text: draft.text === text ? '' : draft.text,
        image: draft.image === image ? '' : draft.image,
      }))
    })
  }
  const stop = () => {
    chat.stop()
    voice.stopSpeaking()
  }
  // 选择图片：限制类型与 4MB 大小，转 data URL 存入草稿；重复选择时取消上一次读取。
  const uploadImage = async (file?: File) => {
    if (!file) return
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
      file.size > 4 * 1024 * 1024
    ) {
      notify('请选择小于 4MB 的 PNG、JPEG 或 WebP 图片')
      return
    }
    imageReader.current?.abort()
    const reader = new FileReader()
    imageReader.current = reader
    reader.onload = () =>
      updateDraft(draftID, (draft) => ({ ...draft, image: String(reader.result) }))
    reader.readAsDataURL(file)
  }
  // 导出当前会话为 Markdown 文件，非完成状态会附带状态标注。
  const exportHistory = () => {
    if (!s.messages.length) {
      notify('开始对话后即可导出聊天记录')
      return
    }
    download(
      `Live2D-${character?.name}-${Date.now()}.md`,
      s.messages
        .map(
          (m) =>
            `### ${m.role === 'user' ? '我' : character?.name}\n\n${m.content}${m.status !== 'complete' ? '\n\n（' + m.status + '）' : ''}`,
        )
        .join('\n\n---\n\n'),
    )
  }
  // 置顶 / 桌宠 / 全屏均依赖桌面客户端能力，失败时给出提示。
  const togglePin = async () => {
    try {
      await api.window('pin', !pinned)
      setPinned(!pinned)
    } catch {
      notify('窗口置顶需要在桌面客户端使用')
    }
  }
  const pet = async () => {
    try {
      await api.window('pet', true)
    } catch {
      notify('请使用桌面客户端打开透明桌宠')
    }
  }
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void container.current?.requestFullscreen().catch(() => notify('当前窗口不支持全屏'))
  }
  const toggleStageCamera = () => {
    if (!camera.enabled) {
      setRightPanel('camera')
      dock.current?.scrollIntoView({ block: 'nearest' })
    }
    camera.toggle()
  }
  // 键盘切换右侧面板：左右方向键循环，Home/End 跳到首/末。
  const switchPanelWithKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const current = workspacePanels.findIndex(({ id }) => id === rightPanel)
    const count = workspacePanels.length
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? count - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + count) % count
    const next = workspacePanels[nextIndex].id
    setRightPanel(next)
    document.getElementById(`workspace-tab-${next}`)?.focus()
  }
  if (!character) return null
  return (
    <div className="studio-workbench">
      <header className="page-header studio-page-header">
        <h1>工作台</h1>
        {s.desktop && (
          <button className="button ghost studio-pet-button" onClick={pet}>
            <Maximize2 size={16} />
            桌宠模式
          </button>
        )}
      </header>
      <div className="studio-scene">
        <section
          className={`stage-column ${s.controlsVisible ? '' : 'is-clean-preview'}`}
          aria-label="Live2D 舞台"
        >
          <StageViewToolbar
            cameraAvailable={!!character}
            cameraEnabled={camera.enabled}
            onToggleCamera={toggleStageCamera}
            onTemplates={() => {
              setRightPanel('stage')
              setStageCategory('templates')
              dock.current?.scrollIntoView({ block: 'nearest' })
              document.getElementById('stage-tab-templates')?.focus({ preventScroll: true })
            }}
          />
          {rightPanel !== 'camera' && camera.message && (
            <div
              className={camera.error ? 'stage-camera-status error' : 'stage-camera-status'}
              role="status"
            >
              {camera.message}
            </div>
          )}
          <div className="stage-viewport" ref={container}>
            <div
              className={`stage stage-${s.stage} ${background ? 'has-media' : ''}`}
              style={stageFrame.style}
              data-aspect={s.aspect}
            >
              <StageBackground />
              {!background && <div className="stage-light" aria-hidden="true" />}
              {s.controlsVisible && (
                <div className="stage-top">
                  <div className="character-switch">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild disabled={s.busy}>
                        <button
                          className="character-pill"
                          aria-label={`切换角色，当前为 ${character.name}`}
                        >
                          <span
                            className="avatar-mini"
                            style={{ background: character.color }}
                            aria-hidden="true"
                          >
                            {character.name[0]}
                          </span>
                          <span>{character.name}</span>
                          <ChevronDown size={14} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="min-w-40">
                        {s.characters.map((c) => (
                          <DropdownMenuItem
                            key={c.id}
                            disabled={s.busy}
                            onSelect={() => {
                              if (character.id !== c.id) {
                                voice.stopSpeaking()
                                s.selectCharacter(c.id)
                              }
                            }}
                          >
                            <span className="color-dot" style={{ background: c.color }} />
                            <span className="flex-1 truncate">{c.name}</span>
                            {s.characterID === c.id && <Check size={14} />}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="stage-actions">
                    <CanvasToolbar onOpen={inspectCanvas} />
                    {s.desktop && (
                      <button
                        className="icon-button glass"
                        aria-label="窗口置顶"
                        aria-pressed={pinned}
                        title="窗口置顶"
                        onClick={() => void togglePin()}
                      >
                        <Pin size={16} />
                      </button>
                    )}
                    <button
                      className="icon-button glass"
                      aria-label="全屏舞台"
                      title="全屏舞台"
                      onClick={fullscreen}
                    >
                      <Maximize2 size={16} />
                    </button>
                  </div>
                </div>
              )}
              <div className="model-position">
                <Live2DStage
                  ref={stageRef}
                  modelPath={character.model_path}
                  actionNames={character.action_names}
                  cameraSample={camera.sample}
                  onCapabilitiesChange={setCapabilities}
                  onInteraction={setInteraction}
                />
              </div>
              <StageEffects effects={s.effects} />
              <StageOverlay />
              <CanvasLayer
                onInspect={inspectCanvas}
                controlsVisible={s.controlsVisible}
                scale={stageFrame.contentScale}
              />
              {s.controlsVisible && (
                <div className="stage-bottom">
                  {activity && (
                    <div className="stage-status">
                      <span className="status-dot pulse" />
                      {activity}
                    </div>
                  )}
                  <div className="zoom-controls" role="group" aria-label="画布缩放">
                    <button
                      aria-label="缩小"
                      disabled={s.zoom <= 0.5}
                      onClick={() => s.patch({ zoom: Math.max(0.5, s.zoom - 0.1) })}
                    >
                      <Minus size={14} />
                    </button>
                    <span>{Math.round(s.zoom * 100)}%</span>
                    <button
                      aria-label="放大"
                      disabled={s.zoom >= 1.7}
                      onClick={() => s.patch({ zoom: Math.min(1.7, s.zoom + 0.1) })}
                    >
                      <Plus size={14} />
                    </button>
                    <i />
                    <button
                      aria-label="重置视图"
                      onClick={() => {
                        s.patch({ zoom: 1 })
                        s.setMood('neutral')
                        stageRef.current?.reset()
                      }}
                    >
                      <RefreshCw size={13} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="canvas-footer">
            <span title={background?.name || '内置背景'}>
              <Layers size={13} />
              <span>{background?.name || '内置背景'}</span>
            </span>
            {activeEffects > 0 && (
              <span>
                <Sparkles size={13} />
                {activeEffects} 层特效
              </span>
            )}
            <button
              onClick={() => {
                setRightPanel('stage')
                dock.current?.scrollIntoView({ block: 'nearest' })
                document.getElementById('workspace-tab-stage')?.focus({ preventScroll: true })
              }}
            >
              <Settings2 size={13} />
              舞台设置
            </button>
          </div>
        </section>
        <aside className="studio-right-dock" ref={dock}>
          <div
            className="workspace-tabs"
            role="tablist"
            aria-label="工作台面板"
            onKeyDown={switchPanelWithKey}
          >
            {workspacePanels.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                id={`workspace-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={rightPanel === id}
                aria-controls={`workspace-${id}`}
                tabIndex={rightPanel === id ? 0 : -1}
                onClick={() => setRightPanel(id)}
              >
                <Icon size={16} aria-hidden="true" />
                {label}
                {((id === 'chat' && s.busy) || (id === 'camera' && camera.previewStream)) && (
                  <span className="panel-busy-dot" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
          <section
            id="workspace-chat"
            role="tabpanel"
            aria-labelledby="workspace-tab-chat"
            className="chat-panel"
            aria-label="聊天面板"
            hidden={rightPanel !== 'chat'}
          >
            <div className="chat-heading">
              <div
                className="chat-avatar"
                style={{ background: character.color }}
                aria-hidden="true"
              >
                {character.name[0]}
              </div>
              <div className="chat-identity">
                <h2>{character.name}</h2>
                <button
                  className="chat-model"
                  onClick={() => navigate('/settings?section=llm')}
                  title={`模型设置 · ${s.settings?.llm.model || '未配置'}`}
                >
                  <Cpu size={12} aria-hidden="true" />
                  <span>{s.settings?.llm.model || '连接模型'}</span>
                </button>
              </div>
              <div className="chat-heading-actions">
                <button
                  className="studio-memory-button"
                  title="管理角色记忆"
                  aria-label={`管理 ${character.name} 的记忆`}
                  onClick={() => setMemoryDialog({})}
                >
                  <Brain size={16} aria-hidden="true" />
                  记忆
                </button>
                <button
                  className="icon-button"
                  aria-label={speechAvailable ? '自动朗读' : '语音设置'}
                  aria-pressed={speechAvailable ? s.speechEnabled : undefined}
                  title={
                    speechAvailable
                      ? s.speechEnabled
                        ? '关闭自动朗读'
                        : '开启自动朗读'
                      : '语音设置'
                  }
                  onClick={() => {
                    if (!speechAvailable) {
                      navigate('/settings?section=speech')
                      return
                    }
                    s.patch({ speechEnabled: !s.speechEnabled })
                    voice.stopSpeaking()
                  }}
                >
                  {s.speechEnabled && speechAvailable ? (
                    <Volume2 size={18} />
                  ) : (
                    <VolumeX size={18} />
                  )}
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="icon-button" aria-label="对话选项">
                      <MoreHorizontal size={20} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-48">
                    <DropdownMenuItem disabled={!s.messages.length} onSelect={exportHistory}>
                      <ArrowDownToLine size={15} />
                      导出对话 Markdown
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={s.busy}
                      onSelect={() => {
                        voice.stopSpeaking()
                        s.selectCharacter(s.characterID)
                        composer.current?.focus()
                      }}
                    >
                      <Plus size={15} />
                      开始新的对话
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <div className="studio-transcript">
              <div
                className="message-scroll"
                ref={transcriptScroll}
                role="region"
                aria-label="聊天记录"
                tabIndex={0}
                onScroll={(event) => {
                  const list = event.currentTarget
                  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 44
                  stickToLatest.current = atBottom
                  setAtLatest(atBottom)
                }}
              >
                {!s.messages.length ? (
                  <div className="chat-welcome">
                    <MessageCircle size={28} strokeWidth={1.65} aria-hidden="true" />
                    <h3>和 {character.name} 开始聊天</h3>
                    <div className="suggestion-list" role="group" aria-label="话题建议">
                      {promptSuggestions.map((suggestion) => (
                        <button
                          key={suggestion}
                          onClick={() => {
                            updateDraft(draftID, (draft) => ({
                              ...draft,
                              text: draft.text.trim() ? `${draft.text}\n${suggestion}` : suggestion,
                            }))
                            composer.current?.focus()
                          }}
                        >
                          {suggestion}
                          <ArrowUpRight size={14} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  s.messages.map((m, index) => {
                    const date = new Date(m.created_at)
                    const messageDate = date.toDateString()
                    const previousDate = index
                      ? new Date(s.messages[index - 1].created_at).toDateString()
                      : ''
                    const validDate = !Number.isNaN(date.getTime())
                    return (
                      <Fragment key={m.id}>
                        {validDate && messageDate !== previousDate && (
                          <div className="chat-date-divider">
                            <time dateTime={m.created_at}>{dateFormat.format(date)}</time>
                          </div>
                        )}
                        <article className={`message message-${m.role}`}>
                          <div className="message-meta">
                            <span>{m.role === 'user' ? '你' : character.name}</span>
                            {validDate && (
                              <time dateTime={m.created_at}>{timeFormat.format(date)}</time>
                            )}
                          </div>
                          {m.image && (
                            <img className="message-image" src={m.image} alt="发送给模型的图片" />
                          )}
                          {m.role === 'assistant' && m.tool_runs?.length ? (
                            <MessageToolRuns runs={m.tool_runs} active={m.status === 'streaming'} />
                          ) : null}
                          {(m.content || m.status === 'streaming') && (
                            <div className="message-bubble">
                              {m.content ? (
                                <Markdown
                                  components={{
                                    a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
                                  }}
                                >
                                  {m.content}
                                </Markdown>
                              ) : (
                                <span className="typing-dots" aria-label="正在生成">
                                  <i />
                                  <i />
                                  <i />
                                </span>
                              )}
                            </div>
                          )}
                          {m.status === 'failed' && (
                            <div className="message-error" role="alert">
                              <p>
                                <CircleAlert size={14} aria-hidden="true" />
                                {m.error || '生成失败，请检查模型设置后重试。'}
                              </p>
                              <div>
                                <button
                                  disabled={s.busy}
                                  onClick={() => {
                                    const previous = s.messages
                                      .slice(0, index)
                                      .reverse()
                                      .find((item) => item.role === 'user')
                                    if (previous) {
                                      voice.stopSpeaking()
                                      scrollToLatest()
                                      void chat.send(previous.content, previous.image)
                                    }
                                  }}
                                >
                                  <RefreshCw size={12} />
                                  重新发送
                                </button>
                                <button onClick={() => navigate('/settings?section=llm')}>
                                  检查模型设置
                                </button>
                              </div>
                            </div>
                          )}
                          {m.status === 'interrupted' && (
                            <small className="message-status">已停止生成</small>
                          )}
                          {m.role === 'user' && m.content.trim() && (
                            <div className="message-actions">
                              <button
                                className="message-memory-action"
                                title="将此消息保存为角色记忆"
                                onClick={() => setMemoryDialog({ initialDraft: m.content })}
                              >
                                <Brain size={14} aria-hidden="true" /> 存为记忆
                              </button>
                            </div>
                          )}
                          {m.role === 'assistant' && m.content && m.status !== 'streaming' && (
                            <div className="message-actions">
                              <button
                                title={copied === m.id ? '已复制' : '复制回复'}
                                aria-label={copied === m.id ? '已复制' : '复制回复'}
                                onClick={() => {
                                  void navigator.clipboard
                                    .writeText(m.content)
                                    .then(() => {
                                      clearTimeout(copyTimer.current)
                                      setCopied(m.id)
                                      copyTimer.current = setTimeout(() => setCopied(''), 1800)
                                    })
                                    .catch(() => notify('无法访问剪贴板'))
                                }}
                              >
                                {copied === m.id ? <Check size={14} /> : <Copy size={14} />}
                              </button>
                              {speechAvailable && (
                                <button
                                  title="朗读回复"
                                  aria-label="朗读回复"
                                  onClick={() => void voice.speak(m.content)}
                                >
                                  <Volume2 size={14} />
                                </button>
                              )}
                            </div>
                          )}
                        </article>
                      </Fragment>
                    )
                  })
                )}
              </div>
              {!atLatest && !!s.messages.length && (
                <button
                  className="transcript-latest"
                  onClick={() => {
                    scrollToLatest()
                    transcriptScroll.current?.focus({ preventScroll: true })
                  }}
                >
                  <ArrowDown size={14} aria-hidden="true" />
                  回到最新消息
                </button>
              )}
            </div>
            <div className="composer-wrap">
              {s.chatError && (
                <p className="connection-error" role="alert">
                  {s.chatError}
                </p>
              )}
              {image && (
                <div className="image-preview">
                  <img src={image} alt="待发送图片" />
                  <span>待发送图片</span>
                  <button
                    aria-label="移除图片"
                    onClick={() => updateDraft(draftID, (draft) => ({ ...draft, image: '' }))}
                  >
                    <X size={13} />
                  </button>
                </div>
              )}
              <form
                className={`composer ${voice.listening ? 'listening' : ''}`}
                onSubmit={(event) => {
                  event.preventDefault()
                  void send()
                }}
              >
                <textarea
                  ref={composer}
                  aria-label="消息"
                  aria-invalid={draftTooLong || undefined}
                  aria-describedby={draftTooLong ? 'studio-draft-limit' : undefined}
                  rows={2}
                  maxLength={messageLimit}
                  placeholder={voice.listening ? '正在录音…' : `发消息给 ${character.name}…`}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                />
                {draftTooLong && (
                  <p id="studio-draft-limit" className="draft-limit" role="status">
                    消息超过 32,000 字节，请缩短后发送。
                  </p>
                )}
                <div className="composer-tools">
                  <div>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="添加图片"
                      title="添加图片，需要支持视觉的模型"
                      onClick={() => upload.current?.click()}
                      disabled={s.busy}
                    >
                      <ImagePlus size={18} />
                    </button>
                    <button
                      type="button"
                      className={`icon-button ${voice.listening ? 'recording' : ''}`}
                      aria-label={voice.listening ? '停止录音' : '语音输入'}
                      title={
                        voice.listening
                          ? '停止录音'
                          : speechAvailable
                            ? '语音输入'
                            : '在设置中启用语音输入'
                      }
                      onClick={() =>
                        speechAvailable
                          ? void voice.toggleListening()
                          : navigate('/settings?section=speech')
                      }
                    >
                      <Mic size={18} />
                    </button>
                    {s.speaking && !s.busy && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="停止朗读"
                        title="停止朗读"
                        onClick={voice.stopSpeaking}
                      >
                        <Square size={14} fill="currentColor" />
                      </button>
                    )}
                    {voice.listening && <span className="recording-label">录音中</span>}
                  </div>
                  {s.busy ? (
                    <button
                      type="button"
                      className="send-button stop-button"
                      aria-label="停止生成"
                      onClick={stop}
                    >
                      <Square size={14} fill="currentColor" />
                      停止
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className="send-button"
                      aria-label="发送消息"
                      disabled={!text.trim() || draftTooLong}
                    >
                      <Send size={15} />
                      发送
                    </button>
                  )}
                </div>
              </form>
              <div className="composer-footer">
                <span className="composer-hint">Enter 发送 · Shift + Enter 换行</span>
                <span className="composer-activity" role="status">
                  {activity}
                </span>
              </div>
              <input
                ref={upload}
                type="file"
                hidden
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  void uploadImage(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
            </div>
          </section>
          <div
            id="workspace-stage"
            role="tabpanel"
            aria-labelledby="workspace-tab-stage"
            className="stage-panel-container"
            hidden={rightPanel !== 'stage'}
          >
            <StageSettingsPanel
              stageRef={stageRef}
              capabilities={capabilities}
              interaction={interaction}
              category={stageCategory}
              onCategoryChange={setStageCategory}
            />
          </div>
          <section
            id="workspace-camera"
            role="tabpanel"
            aria-labelledby="workspace-tab-camera"
            className="camera-panel"
            hidden={rightPanel !== 'camera'}
          >
            {rightPanel === 'camera' && (
              <CameraPanel
                stream={camera.previewStream}
                enabled={camera.enabled}
                message={camera.message}
                error={camera.error}
                onToggle={camera.toggle}
              />
            )}
          </section>
        </aside>
      </div>
      {memoryDialog && (
        <CharacterMemories
          key={character.id}
          character={character}
          initialDraft={memoryDialog.initialDraft}
          onClose={() => setMemoryDialog(null)}
        />
      )}
    </div>
  )
}
