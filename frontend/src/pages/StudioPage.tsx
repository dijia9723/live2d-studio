import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Markdown from 'react-markdown'
import {
  ArrowDownToLine,
  ArrowUp,
  AudioLines,
  Check,
  ChevronDown,
  Copy,
  ImagePlus,
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
  Layers,
  Sparkles,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import Live2DStage from '../components/Live2DStage'
import type { Live2DCapabilities, Live2DStageHandle } from '../components/Live2DStage'
import StageSettingsPanel from '../components/StageSettingsPanel'
import StageBackground from '../components/StageBackground'
import StageEffects from '../components/StageEffects'
import StageOverlay from '../components/StageOverlay'
import { useStudio, notify } from '../store/studio'
import { useChat } from '../hooks/useChat'
import { useSpeech } from '../hooks/useSpeech'
import { api } from '../api/client'
import { download } from '../utils/format'

export default function StudioPage() {
  const s = useStudio()
  const navigate = useNavigate()
  const character = s.characters.find((c) => c.id === s.characterID) || s.characters[0]
  const [text, setText] = useState('')
  const [image, setImage] = useState('')
  const [pinned, setPinned] = useState(false)
  const [menu, setMenu] = useState(false)
  const [copied, setCopied] = useState('')
  const [showCharacters, setShowCharacters] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const upload = useRef<HTMLInputElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const stageRef = useRef<Live2DStageHandle>(null)
  const [capabilities, setCapabilities] = useState<Live2DCapabilities | null>(null)
  const [interaction, setInteraction] = useState('')
  const [rightPanel, setRightPanel] = useState<'chat' | 'stage'>('chat')
  const background = s.sceneAssets.find((item) => item.id === s.backgroundAssetID)
  const activeEffects =
    s.effects.filter((effect) => effect.enabled).length + (s.overlayAssetID ? 1 : 0)
  const stopRef = useRef<() => void>(() => {})
  const sendRef = useRef<(t: string) => void>(() => {})
  const transcript = useCallback((t: string) => {
    setText(t)
    composer.current?.focus()
  }, [])
  const interrupt = useCallback(() => stopRef.current(), [])
  const voice = useSpeech(transcript, interrupt)
  const reply = useCallback(
    (t: string) => {
      if (useStudio.getState().speechEnabled) void voice.speak(t)
    },
    [voice.speak],
  )
  const chat = useChat(reply)
  useEffect(() => setInteraction(''), [character?.model_path])
  stopRef.current = chat.stop
  sendRef.current = (t) => void chat.send(t)
  useEffect(() => {
    if (rightPanel === 'chat') end.current?.scrollIntoView({ behavior: s.busy ? 'instant' : 'smooth', block: 'end' })
  }, [s.messages, s.busy, rightPanel])
  const send = async (value = text) => {
    if (!value.trim() || s.busy) return
    voice.stopSpeaking()
    setText('')
    setImage('')
    await chat.send(value, image)
  }
  const stop = () => {
    chat.stop()
    voice.stopSpeaking()
  }
  const uploadImage = async (file?: File) => {
    if (!file) return
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
      file.size > 4 * 1024 * 1024
    ) {
      notify('请选择小于 4MB 的 PNG、JPEG 或 WebP 图片')
      return
    }
    const reader = new FileReader()
    reader.onload = () => setImage(String(reader.result))
    reader.readAsDataURL(file)
  }
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
  if (!character) return null
  return (
    <>
      <header className="page-header">
        <div>
          <div className="eyebrow">YOUR LITTLE WORLD</div>
          <h1>
            陪伴工作室<span>与你的 AI 伙伴，一起度过好时光。</span>
          </h1>
        </div>
        <div className="header-actions">
          <span className="local-badge">
            <span className="status-dot" />
            本地存储
          </span>
          <button className="button ghost" onClick={pet}>
            <Maximize2 size={15} />
            桌宠模式
          </button>
          <button className="icon-button" title="模型设置" onClick={() => navigate('/settings')}>
            <Settings2 size={19} />
          </button>
        </div>
      </header>
      <div className="studio-content">
        <section className="stage-column">
          <div className="section-label">
            <span>
              <span className="tiny-square" />
              LIVE2D 舞台
            </span>
            <span className="muted">属于你们的小小空间</span>
          </div>
          <div
            className={`stage stage-${s.stage} ${background ? 'has-media' : ''}`}
            ref={container}
          >
            <StageBackground />
            <div className="stage-grain" />
            <div className="stage-orbit orbit-one" />
            <div className="stage-orbit orbit-two" />
            <span className="stage-spark spark-one">✧</span>
            <span className="stage-spark spark-two">✦</span>
            <span className="stage-spark spark-three">＋</span>
            <div className="stage-top">
              <div className="character-switch">
                <button
                  className="character-pill"
                  onClick={() => setShowCharacters(!showCharacters)}
                  disabled={s.busy}
                >
                  <span className="avatar-mini" style={{ background: character.color }}>
                    {character.name[0]}
                  </span>
                  <span>{character.name}</span>
                  <ChevronDown size={14} />
                </button>
                {showCharacters && (
                  <div className="character-popover">
                    {s.characters.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => {
                          voice.stopSpeaking()
                          s.selectCharacter(c.id)
                          setShowCharacters(false)
                        }}
                      >
                        <span className="color-dot" style={{ background: c.color }} />
                        {c.name}
                        {s.characterID === c.id && <Check size={14} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="stage-actions">
                <span className="live-badge">
                  <span />
                  LIVE
                </span>
                <button
                  className={`icon-button glass ${pinned ? 'purple' : ''}`}
                  aria-label="窗口置顶"
                  onClick={() => void togglePin()}
                >
                  <Pin size={16} />
                </button>
                <button className="icon-button glass" aria-label="全屏舞台" onClick={fullscreen}>
                  <Maximize2 size={16} />
                </button>
              </div>
            </div>
            <div className="stage-caption">
              <span>HELLO, HUMAN.</span>
              <h2>
                今天也很高兴见到你<span>✿</span>
              </h2>
            </div>
            <div className="model-position">
              <Live2DStage
                ref={stageRef}
                modelPath={character.model_path}
                onCapabilitiesChange={setCapabilities}
                onInteraction={setInteraction}
              />
            </div>
            <StageEffects effects={s.effects} />
            <StageOverlay />
            <div className="stage-bottom">
              <div className="stage-status">
                <span className={`status-dot ${s.speaking || s.busy ? 'pulse' : ''}`} />
                {voice.listening
                  ? '我在听，慢慢说…'
                  : s.speaking
                    ? '正在与你分享…'
                    : s.busy
                      ? '让我想一想…'
                      : '我在这里，随时陪你聊天'}
              </div>
              <div className="zoom-controls">
                <button
                  aria-label="缩小"
                  onClick={() => s.patch({ zoom: Math.max(0.5, s.zoom - 0.1) })}
                >
                  <Minus size={14} />
                </button>
                <span>{Math.round(s.zoom * 100)}%</span>
                <button
                  aria-label="放大"
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
          </div>
          <div className="canvas-footer">
            <span>
              <Layers size={13} />
              {background?.name || '内置氛围背景'}
            </span>
            <span>
              <Sparkles size={13} />
              {activeEffects ? `${activeEffects} 层特效` : '纯净画面'}
            </span>
            <button onClick={() => setRightPanel('stage')}>
              <Settings2 size={13} />
              布置舞台
            </button>
          </div>
        </section>
        <aside className="studio-right-dock">
          <div className="workspace-tabs" role="tablist" aria-label="工作台面板">
            <button
              id="workspace-tab-chat"
              role="tab"
              aria-selected={rightPanel === 'chat'}
              aria-controls="workspace-chat"
              onClick={() => setRightPanel('chat')}
            >
              <MessageCircle size={16} />
              AI 对话{s.busy && <span className="panel-busy-dot" />}
            </button>
            <button
              id="workspace-tab-stage"
              role="tab"
              aria-selected={rightPanel === 'stage'}
              aria-controls="workspace-stage"
              onClick={() => setRightPanel('stage')}
            >
              <Layers size={16} />
              舞台设置
            </button>
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
              <div className="chat-avatar" style={{ background: character.color }}>
                {character.name[0]}
                <span />
              </div>
              <div>
                <h2>与 {character.name} 的对话</h2>
                <p>
                  <span className="status-dot" />
                  {s.busy ? '正在思考' : '准备好倾听'}
                </p>
              </div>
              <div className="chat-heading-actions">
                <button
                  className={`icon-button ${!s.speechEnabled ? 'muted' : ''}`}
                  title={s.speechEnabled ? '关闭自动朗读' : '开启自动朗读'}
                  onClick={() => {
                    s.patch({ speechEnabled: !s.speechEnabled })
                    voice.stopSpeaking()
                  }}
                >
                  {s.speechEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
                </button>
                <div className="menu-anchor">
                  <button
                    className="icon-button"
                    aria-label="对话选项"
                    onClick={() => setMenu(!menu)}
                  >
                    <MoreHorizontal size={20} />
                  </button>
                  {menu && (
                    <div className="dropdown-menu">
                      <button
                        onClick={() => {
                          exportHistory()
                          setMenu(false)
                        }}
                      >
                        <ArrowDownToLine size={15} />
                        导出对话 Markdown
                      </button>
                      <button
                        disabled={s.busy}
                        onClick={() => {
                          s.selectCharacter(s.characterID)
                          setMenu(false)
                        }}
                      >
                        <Plus size={15} />
                        开始新的对话
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="message-scroll">
              {!s.messages.length ? (
                <div className="chat-welcome">
                  <div className="welcome-flower">
                    <Sparkles size={27} strokeWidth={1.4} />
                  </div>
                  <span className="welcome-date">一段新故事的开始</span>
                  <h3>
                    嘿，我是 {character.name} <span>✧</span>
                  </h3>
                  <p>
                    忙碌的一天里，也记得给自己
                    <br />
                    留一点放松的时间。今天想聊些什么？
                  </p>
                  <div className="suggestion-list">
                    {['今天发生了什么有趣的事？', '陪我聊一会儿吧', '给我一点灵感 ✨'].map((t) => (
                      <button key={t} onClick={() => void send(t)}>
                        {t}
                        <ArrowUp size={13} />
                      </button>
                    ))}
                  </div>
                  <button className="setup-hint" onClick={() => navigate('/settings')}>
                    <Settings2 size={13} />
                    首次使用？先连接你的模型
                    <ChevronDown size={12} />
                  </button>
                </div>
              ) : (
                <>
                  <div className="chat-date-divider">
                    <span>每一句，都值得被记住</span>
                  </div>
                  {s.messages.map((m, index) => (
                    <article className={`message message-${m.role}`} key={m.id}>
                      <div className="message-meta">
                        <span>{m.role === 'user' ? '你' : character.name}</span>
                        <time>
                          {new Date(m.created_at).toLocaleTimeString('zh-CN', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </time>
                      </div>
                      {m.image && (
                        <img className="message-image" src={m.image} alt="发送给模型的图片" />
                      )}
                      <div className="message-bubble">
                        {m.content ? (
                          <Markdown
                            components={{
                              a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
                            }}
                          >
                            {m.content}
                          </Markdown>
                        ) : m.status === 'streaming' ? (
                          <span className="typing-dots">
                            <i />
                            <i />
                            <i />
                          </span>
                        ) : (
                          <span className="muted">
                            {m.status === 'interrupted'
                              ? '已停止生成'
                              : '未收到回复，请检查设置后重试'}
                          </span>
                        )}
                      </div>
                      {m.status === 'failed' && (
                        <div className="message-error" role="alert">
                          <p>{m.error || '生成失败，请检查模型设置后重试。'}</p>
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
                                  void chat.send(previous.content, previous.image)
                                }
                              }}
                            >
                              <RefreshCw size={12} />
                              重新发送
                            </button>
                            <button onClick={() => navigate('/settings')}>检查模型设置</button>
                          </div>
                        </div>
                      )}
                      {m.status === 'interrupted' && (
                        <small className="message-status">已停止生成</small>
                      )}
                      {m.role === 'assistant' && m.content && (
                        <div className="message-actions">
                          <button
                            title="复制"
                            onClick={() => {
                              void navigator.clipboard
                                .writeText(m.content)
                                .then(() => {
                                  setCopied(m.id)
                                  setTimeout(() => setCopied(''), 1800)
                                })
                                .catch(() => notify('无法访问剪贴板'))
                            }}
                          >
                            {copied === m.id ? <Check size={12} /> : <Copy size={12} />}
                          </button>
                          <button title="朗读" onClick={() => void voice.speak(m.content)}>
                            <Volume2 size={12} />
                          </button>
                        </div>
                      )}
                    </article>
                  ))}
                </>
              )}
              <div ref={end} />
            </div>
            <div className="composer-wrap">
              {s.chatError && !s.messages.some((m) => m.status === 'failed') && (
                <p className="connection-error" role="alert">
                  {s.chatError}
                </p>
              )}
              {image && (
                <div className="image-preview">
                  <img src={image} alt="待发送图片" />
                  <button aria-label="移除图片" onClick={() => setImage('')}>
                    <X size={13} />
                  </button>
                  <span>图片将随消息发送</span>
                </div>
              )}
              <div className={`composer ${voice.listening ? 'listening' : ''}`}>
                <textarea
                  ref={composer}
                  aria-label="消息"
                  rows={3}
                  maxLength={16000}
                  placeholder={
                    voice.listening ? '正在聆听你的声音…' : `和 ${character.name} 说点什么…`
                  }
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                />
                <div className="composer-tools">
                  <div>
                    <button
                      className="icon-button"
                      title="添加图片（需要视觉模型）"
                      onClick={() => upload.current?.click()}
                      disabled={s.busy}
                    >
                      <ImagePlus size={18} />
                    </button>
                    <button
                      className={`icon-button ${voice.listening ? 'recording' : ''}`}
                      title={voice.listening ? '停止录音' : '语音输入'}
                      onClick={() => void voice.toggleListening()}
                    >
                      <Mic size={18} />
                    </button>
                    <span className="composer-hint">
                      {voice.listening ? '再次点击结束录音' : 'Shift + Enter 换行'}
                    </span>
                  </div>
                  {s.busy || s.speaking ? (
                    <button
                      className="send-button stop-button"
                      aria-label="停止生成与朗读"
                      onClick={stop}
                    >
                      <Square size={15} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      aria-label="发送消息"
                      disabled={!text.trim()}
                      onClick={() => void send()}
                    >
                      <Send size={17} />
                    </button>
                  )}
                </div>
              </div>
              <div className="composer-footer">
                <AudioLines size={12} />
                <span>{s.settings?.llm.model || '未配置模型'}</span>
                <span>
                  让灵感自然发生 <span className="purple">✦</span>
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
            />
          </div>
        </aside>
      </div>
    </>
  )
}
