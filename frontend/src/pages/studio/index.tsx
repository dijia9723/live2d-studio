/**
 * 页面：AI 对话主工作台，组合 Live2D 舞台、消息列表与输入区。
 * 左侧显示角色舞台，右侧切换对话、历史、舞台设置、摄像头和直播。
 * 同时管理草稿、图片附件、自动滚动、语音输入与朗读、历史导出等交互。
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Markdown from 'react-markdown'
import {
  ArrowDownToLine,
  ArrowDown,
  ArrowUpRight,
  Brain,
  Check,
  ChevronDown,
  CircleAlert,
  Code2,
  Copy,
  Cpu,
  Eye,
  History,
  ImagePlus,
  Layers,
  Maximize2,
  Mic,
  MessageCircle,
  Minus,
  MoreHorizontal,
  Pin,
  Plus,
  Radio,
  RefreshCw,
  ScanLine,
  Send,
  Settings2,
  Sparkles,
  Square,
  Video,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import CharacterMemories from '../../components/character/CharacterMemories'
import MessageToolRuns from '../../components/chat/MessageToolRuns'
import { useSharedLive2DStage } from '../../components/stage/SharedLive2DStage'
import type { Live2DCapabilities } from '../../components/stage/Live2DStage'
import StageSettingsPanel from '../../components/stage/StageSettingsPanel'
import StageBackground from '../../components/stage/StageBackground'
import StageEffects from '../../components/stage/StageEffects'
import StageOverlay from '../../components/stage/StageOverlay'
import { backgroundHTMLPresets } from '../../components/stage/stageHTMLPresets'
import CanvasLayer from '../../components/canvas/CanvasLayer'
import CanvasToolbar from '../../components/canvas/CanvasToolbar'
import StageViewToolbar from '../../components/stage/StageViewToolbar'
import CameraPanel, { type CameraPreviewMode } from '../../components/camera/CameraPanel'
import ConversationHistory from '../../components/chat/ConversationHistory'
import LiveModePanel from '../../components/live/LiveModePanel'
import { Textarea } from '../../components/ui/textarea'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import { useStudio, notify } from '../../store/studio'
import { useHotkeys } from '../../store/hotkeys'
import { stageAspectPresets } from '../../types/stage'
import { ariaHotkey, formatHotkey } from '../../utils/hotkeys'
import { draftKey, emptyDraft, updateDraft, useChatDrafts } from '../../store/chatDrafts'
import { useChat } from '../../hooks/useChat'
import { useDesktopSnip } from '../../hooks/useDesktopSnip'
import { useCameraTracking } from '../../hooks/useCameraTracking'
import { useLiveMode } from '../../hooks/useLiveMode'
import { useStageFrame } from '../../hooks/useStageFrame'
import { useStageOutput } from '../../hooks/useStageOutput'
import { useStageHotkeys } from '../../hooks/useStageHotkeys'
import { useSpeech } from '../../hooks/useSpeech'
import { api } from '../../api/client'
import { download } from '../../utils/format'

const messageLimit = 32000
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long' })
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' })
const promptSuggestions = ['陪我聊聊今天', '给我一个放松的小建议', '你记得我哪些偏好？']
const workspacePanels = [
  { id: 'chat', label: '对话', icon: MessageCircle },
  { id: 'history', label: '对话记录', icon: History },
  { id: 'stage', label: '舞台设置', icon: Layers },
  { id: 'camera', label: '摄像头', icon: Video },
  { id: 'live', label: '直播模式', icon: Radio },
] as const
type WorkspacePanel = (typeof workspacePanels)[number]['id']

export default function StudioPage() {
  const s = useStudio()
  const navigate = useNavigate()
  const [search] = useSearchParams()
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
  const outputTarget = useRef<HTMLDivElement>(null)
  const stageOutput = useStageOutput(outputTarget)
  const showStageControls = s.controlsVisible && stageOutput.state.phase !== 'live' && stageOutput.state.phase !== 'starting'
  const dock = useRef<HTMLElement>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [capabilities, setCapabilities] = useState<Live2DCapabilities | null>(null)
  const [interaction, setInteraction] = useState('')
  // 与模型工作台共享同一个舞台；本页只注册画布落点。
  const { stageRef, stageSlotRef } = useSharedLive2DStage({
    enabled: !!character,
    modelPath: character?.model_path,
    actionNames: character?.action_names,
    cameraSample: camera.sample,
    onCapabilitiesChange: setCapabilities,
    onInteraction: setInteraction,
  })
  const [rightPanel, setRightPanel] = useState<WorkspacePanel>(
    () => (search.get('panel') === 'live' ? 'live' : 'chat'),
  )
  const [cameraPreviewMode, setCameraPreviewMode] = useState<CameraPreviewMode>('skeleton')
  const [stageCategory, setStageCategory] = useState('character')
  const [screenSnipRequest, setScreenSnipRequest] = useState<{ id: string; reason: string } | null>(null)
  const desktopSnip = useDesktopSnip(s.desktop)
  const modePending = useRef(false)
  const captureHotkey = useHotkeys((state) => state.bindings.captureScreen)
  const visibleScreenRequest = screenSnipRequest?.id === s.conversationID ? screenSnipRequest : null
  const inspectCanvas = useCallback(() => {
    setRightPanel('stage')
    setStageCategory('widgets')
  }, [])
  const background =
    backgroundHTMLPresets.find((item) => item.id === s.backgroundAssetID) ??
    s.sceneAssets.find((item) => item.id === s.backgroundAssetID)
  // 两栏配比跟随画布比例：宽画布偏舞台，竖画布偏右侧面板。
  const aspectRatio = stageAspectPresets.find((preset) => preset.id === s.aspect)?.ratio ?? 0
  const aspectShape =
    aspectRatio === 0 ? 'auto' : aspectRatio > 1 ? 'landscape' : aspectRatio < 1 ? 'portrait' : 'square'
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
  const speechOwner = useRef<'chat' | 'live' | undefined>(undefined)
  const speakLive = useCallback(
    (text: string) => {
      speechOwner.current = 'live'
      return voice.speak(text)
    },
    [voice.speak],
  )
  const stopLiveSpeech = useCallback(() => {
    if (speechOwner.current !== 'live') return
    speechOwner.current = undefined
    voice.stopSpeaking()
  }, [voice.stopSpeaking])
  const live = useLiveMode({
    selected: rightPanel === 'live',
    character,
    stage: stageRef,
    chatBusy: s.busy || voice.listening,
    speaking: s.speaking,
    speak: speakLive,
    stopSpeaking: stopLiveSpeech,
  })
  const activity = voice.listening
    ? '正在录音'
    : s.busy
      ? '正在生成'
      : s.speaking
        ? '正在朗读'
        : live.state?.busy && live.state.config.character_id === character?.id
          ? '直播 AI 正在回应'
          : ''
  const reply = useCallback(
    (t: string) => {
      if (!useStudio.getState().speechEnabled) return
      speechOwner.current = 'chat'
      void voice.speak(t)
    },
    [voice.speak],
  )
  const requestScreenSnip = useCallback((id: string, reason: string) => {
    setScreenSnipRequest({ id, reason })
  }, [])
  const chat = useChat(reply, stageRef, desktopSnip.available ? requestScreenSnip : undefined)
  useEffect(() => setInteraction(''), [character?.model_path])
  stopRef.current = chat.stop
  const showChatFromHistory = () => {
    voice.stopSpeaking()
    setRightPanel('chat')
    document.getElementById('workspace-tab-chat')?.focus({ preventScroll: true })
  }
  const startNewChat = () => {
    if (useStudio.getState().busy) return
    s.selectCharacter(s.characterID)
    if (rightPanel === 'history') showChatFromHistory()
    else {
      voice.stopSpeaking()
      composer.current?.focus()
    }
  }
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
  const captureScreen = async () => {
    if (!desktopSnip.available || desktopSnip.capturing || useStudio.getState().busy) return
    setRightPanel('chat')
    const owner = useStudio.getState()
    try {
      const snip = await desktopSnip.capture({
        character_id: owner.characterID, conversation_id: owner.conversationID,
      })
      if (!snip) return
      if (snip.watch_id) {
        voice.stopSpeaking()
        setScreenSnipRequest(null)
        return
      }
      const capture = snip.image
      if (!capture) return
      imageReader.current?.abort()
      updateDraft(draftID, (draft) => ({
        image: capture,
        text: draft.text || (visibleScreenRequest ? '这是你请求的截图。' : ''),
      }))
      setScreenSnipRequest((current) => current === visibleScreenRequest ? null : current)
      composer.current?.focus({ preventScroll: true })
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Windows 截图失败')
    }
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
  const togglePin = async () => {
    try {
      await api.window('pin', !pinned)
      setPinned(!pinned)
    } catch {
      notify('窗口置顶需要在桌面客户端使用')
    }
  }
  const openMode = async (mode: 'pet' | 'coding', chooseWindow = false) => {
    const owner = useStudio.getState()
    if (owner.busy || desktopSnip.capturing || modePending.current) return
    voice.stopSpeaking()
    if (mode === 'coding' && !owner.desktop) {
      navigate('/coding')
      return
    }
    modePending.current = true
    try {
      await api.window(mode, true, mode === 'pet' ? {
        character_id: owner.characterID,
        conversation_id: owner.conversationID,
        choose_window: chooseWindow,
      } : undefined)
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '无法切换窗口')
    } finally {
      modePending.current = false
    }
  }
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void container.current?.requestFullscreen().catch(() => notify('当前窗口不支持全屏'))
  }
  const toggleStageCamera = () => {
    if (!character) return
    if (!camera.enabled) {
      setRightPanel('camera')
      dock.current?.scrollIntoView({ block: 'nearest' })
    }
    camera.toggle()
  }
  useStageHotkeys(container, stageRef, !!character, {
    toggleControls: () => s.patch({ controlsVisible: !useStudio.getState().controlsVisible }),
    toggleFullscreen: fullscreen,
    toggleCamera: toggleStageCamera,
    newConversation: startNewChat,
    captureScreen: desktopSnip.available ? () => void captureScreen() : undefined,
  })
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
  const switchingUnavailable = s.busy || desktopSnip.capturing
  const header = (
    <header className="page-header studio-page-header">
      <h1>工作台</h1>
      <div className="studio-mode-actions" aria-label="切换模式" role="group">
        <button type="button" className="button ghost" disabled={switchingUnavailable} onClick={() => void openMode('coding')}>
          <Code2 size={16} />
          编码模式
        </button>
        {s.desktop && (
          <button type="button" className="button ghost" disabled={switchingUnavailable} onClick={() => void openMode('pet')}>
            <Maximize2 size={16} />
            桌宠模式
          </button>
        )}
      </div>
    </header>
  )
  if (!character) return <div className="studio-workbench">{header}</div>
  return (
    <div className="studio-workbench">
      {header}
      <div className="studio-scene" data-aspect-shape={aspectShape}>
        <section
          className={`stage-column ${s.controlsVisible ? '' : 'is-clean-preview'}`}
          aria-label="Live2D 舞台"
        >
          <StageViewToolbar
            output={stageOutput}
            cameraAvailable={!!character}
            cameraEnabled={camera.enabled}
            onToggleCamera={toggleStageCamera}
            onResetModelView={() => stageRef.current?.resetModelView()}
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
              ref={outputTarget}
              className={`stage stage-${s.stage} ${background ? 'has-media' : ''}`}
              style={stageFrame.style}
              data-aspect={s.aspect}
            >
              <StageBackground />
              {!background && <div className="stage-light" aria-hidden="true" />}
              {showStageControls && (
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
              <div className="model-position" ref={stageSlotRef} />
              <StageEffects effects={s.effects} />
              <StageOverlay />
              <CanvasLayer
                onInspect={inspectCanvas}
                controlsVisible={showStageControls}
                scale={stageFrame.contentScale}
              />
              {live.caption && (
                <div className={`live-caption ${showStageControls ? '' : 'is-clean'}`}>
                  <p>{live.caption}</p>
                </div>
              )}
              {showStageControls && (
                <div className="stage-bottom">
                  {activity && (
                    <div className="stage-status">
                      <span className="status-dot pulse" />
                      {activity}
                    </div>
                  )}
                  <div className="zoom-controls" role="group" aria-label="角色缩放">
                    <button
                      aria-label="缩小"
                      disabled={s.zoom <= s.modelZoomLimits.min / 100}
                      onClick={() => s.patch({ zoom: (Math.round(s.zoom * 100) - 10) / 100 })}
                    >
                      <Minus size={14} />
                    </button>
                    <span>{Math.round(s.zoom * 100)}%</span>
                    <button
                      aria-label="放大"
                      disabled={s.zoom >= s.modelZoomLimits.max / 100}
                      onClick={() => s.patch({ zoom: (Math.round(s.zoom * 100) + 10) / 100 })}
                    >
                      <Plus size={14} />
                    </button>
                    <i />
                    <button
                      aria-label="重置视图"
                      onClick={() => {
                        stageRef.current?.resetModelView()
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
                {((id === 'chat' && s.busy) ||
                  (id === 'camera' && camera.previewStream) ||
                  (id === 'live' && live.state?.running)) && (
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
                      onSelect={startNewChat}
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
              {visibleScreenRequest && (
                <div className="chat-screen-request">
                  <div>
                    <strong>智能体请求截图</strong>
                    <p>{visibleScreenRequest.reason}</p>
                  </div>
                  <button
                    type="button"
                    className="button soft"
                    disabled={s.busy || desktopSnip.capturing}
                    onClick={() => void captureScreen()}
                  >
                    框选屏幕
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="忽略截图请求"
                    onClick={() => setScreenSnipRequest(null)}
                  >
                    <X size={15} aria-hidden="true" />
                  </button>
                </div>
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
                <Textarea
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
                    {desktopSnip.available && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="截取 Windows 屏幕"
                        aria-keyshortcuts={ariaHotkey(captureHotkey)}
                        title={captureHotkey ? `截取屏幕（${formatHotkey('captureScreen', captureHotkey)}）` : '截取屏幕'}
                        disabled={s.busy || desktopSnip.capturing}
                        onClick={() => void captureScreen()}
                      >
                        <ScanLine size={18} aria-hidden="true" />
                      </button>
                    )}
                    {desktopSnip.available && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="icon-button screen-watch-trigger"
                            aria-label="一起看"
                            title="一起看"
                            disabled={s.busy || desktopSnip.capturing}
                          >
                            <Eye size={18} aria-hidden="true" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" side="top">
                          {typeof navigator.mediaDevices?.getDisplayMedia === 'function' && (
                            <DropdownMenuItem onSelect={() => void openMode('pet', true)}>选择观看窗口</DropdownMenuItem>
                          )}
                          <DropdownMenuItem onSelect={() => void captureScreen()}>框选区域，在截图工具栏点「一起看」</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => navigate('/settings?section=screen-watch')}>配置观看模型</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
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
          <section
            id="workspace-history"
            role="tabpanel"
            aria-labelledby="workspace-tab-history"
            className="history-panel"
            hidden={rightPanel !== 'history'}
          >
            <ConversationHistory
              key={character.id}
              characterID={character.id}
              characterName={character.name}
              onStart={startNewChat}
              onOpen={showChatFromHistory}
            />
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
                landmarks={camera.landmarks}
                mode={cameraPreviewMode}
                onModeChange={setCameraPreviewMode}
                enabled={camera.enabled}
                message={camera.message}
                error={camera.error}
                onToggle={camera.toggle}
              />
            )}
          </section>
          <section
            id="workspace-live"
            role="tabpanel"
            aria-labelledby="workspace-tab-live"
            className="live-panel-container"
            hidden={rightPanel !== 'live'}
          >
            <LiveModePanel
              live={live}
              characterID={character.id}
              chatBusy={s.busy || voice.listening}
              speaking={s.speaking && speechOwner.current === 'live'}
              stageFeedback={interaction}
              stopSpeaking={stopLiveSpeech}
              selectHost={(id) => {
                voice.stopSpeaking()
                s.selectCharacter(id)
              }}
            />
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
