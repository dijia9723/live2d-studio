/**
 * 页面：角色模型工作室（角色库 → 编辑子页面）。
 * 左侧是大尺寸实时舞台，右侧按标签页可视化配置：
 * 播放模型全部动作（支持自动轮播与快捷键）、切换情绪与原生表情、
 * 调整背景/特效/叠加层，以及编辑角色人设（含未保存提醒）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Image as ImageIcon,
  LoaderCircle,
  Minus,
  Play,
  Plus,
  RotateCcw,
  Save,
  Shuffle,
  Smile,
  Sparkles,
  UserRound,
  X,
} from 'lucide-react'
import Live2DStage from '../components/stage/Live2DStage'
import type { Live2DCapabilities, Live2DStageHandle } from '../components/stage/Live2DStage'
import StageBackground from '../components/stage/StageBackground'
import StageEffects, { effectPresets } from '../components/stage/StageEffects'
import StageOverlay from '../components/stage/StageOverlay'
import BackgroundManager from '../components/stage/BackgroundManager'
import OverlayManager from '../components/stage/OverlayManager'
import { MoodFace } from '../components/stage/StageControls'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select'
import { Switch } from '../components/ui/switch'
import { api } from '../api/client'
import { notify, useStudio } from '../store/studio'
import type { Character } from '../types/api'

const moods = [
  { key: 'neutral', label: '自然' },
  { key: 'happy', label: '开心' },
  { key: 'sad', label: '难过' },
  { key: 'surprised', label: '惊讶' },
]

const tabs = [
  { id: 'actions', name: '动作与表情', Icon: Smile },
  { id: 'stage', name: '舞台外观', Icon: Sparkles },
  { id: 'profile', name: '角色人设', Icon: UserRound },
] as const

type TabID = (typeof tabs)[number]['id']

export default function CharacterStudioPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const s = useStudio()
  const character = s.characters.find((item) => item.id === id)
  const [tab, setTab] = useState<TabID>('actions')
  const stageRef = useRef<Live2DStageHandle>(null)
  const [capabilities, setCapabilities] = useState<Live2DCapabilities | null>(null)
  const [interaction, setInteraction] = useState('')
  const [activeMotion, setActiveMotion] = useState('')
  const [expression, setExpression] = useState('')
  const [group, setGroup] = useState('all')
  const [autoPlay, setAutoPlay] = useState(false)
  const [autoInterval, setAutoInterval] = useState(5)
  const [profileDirty, setProfileDirty] = useState(false)
  // 用 ref 保存最新的随机播放函数，供定时器与快捷键调用，避免反复重建。
  const playRandomRef = useRef<() => void>(() => {})
  const background = s.sceneAssets.find((item) => item.id === s.backgroundAssetID)
  const ready = capabilities?.ready ?? false
  const zoomMin = s.modelZoomLimits.min / 100
  const zoomMax = s.modelZoomLimits.max / 100
  // 动作按 group 分组；空组名统一归入“动作”。
  const groups = useMemo(
    () => Array.from(new Set((capabilities?.motions ?? []).map((m) => m.group || '动作'))),
    [capabilities],
  )
  const activeGroup = group === 'all' || groups.includes(group) ? group : 'all'
  const motions = (capabilities?.motions ?? []).filter(
    (m) => activeGroup === 'all' || (m.group || '动作') === activeGroup,
  )
  const activeEffects = s.effects.filter((effect) => effect.enabled).length + (s.overlayAssetID ? 1 : 0)
  const setEffect = (effectID: string, patch: { enabled?: boolean; intensity?: number }) => {
    const current = s.effects.find((effect) => effect.id === effectID)
    s.patch({
      effects: [
        ...s.effects.filter((effect) => effect.id !== effectID),
        { id: effectID, enabled: false, intensity: 0.5, ...current, ...patch },
      ],
    })
  }

  // 切换角色时清空舞台反馈与本地选中项。
  useEffect(() => {
    setInteraction('')
    setActiveMotion('')
    setExpression('')
    setGroup('all')
  }, [character?.model_path])
  // 外部（如 AI 切换表情）更新情绪时退出原生表情模式。
  useEffect(() => {
    setExpression('')
  }, [s.expressionRevision])
  // 自动轮播：按间隔随机挑选动作；页面在后台时暂停，避免无意义播放。
  useEffect(() => {
    if (!autoPlay || !ready) return
    const timer = setInterval(() => {
      if (!document.hidden) playRandomRef.current()
    }, autoInterval * 1000)
    return () => clearInterval(timer)
  }, [autoPlay, autoInterval, ready])
  // 人设存在未保存内容时，关闭窗口前给出浏览器原生提示。
  useEffect(() => {
    if (!profileDirty) return
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [profileDirty])

  if (!character) {
    return (
      <div className="character-studio-page character-studio-missing">
        <p>找不到这个角色，可能已被移除。</p>
        <Link className="button ghost" to="/characters">
          <ArrowLeft size={15} /> 返回角色库
        </Link>
      </div>
    )
  }

  const applyMood = (mood: string) => {
    setExpression('')
    s.setMood(mood)
    stageRef.current?.setMood(mood)
  }
  const applyExpression = async (name: string | null) => {
    if (name === null) {
      applyMood('neutral')
      return
    }
    const applied = await stageRef.current?.setExpression(name)
    setExpression(applied ? name : '')
  }
  // 选定动作后立即播放；播放失败时清空高亮。
  const play = async (motionID?: string) => {
    setActiveMotion(motionID ?? '')
    const started = await stageRef.current?.playMotion(motionID)
    if (!started) setActiveMotion('')
  }
  // 随机挑选一个非 Idle 的反应动作；没有反应动作时从全部动作中选。
  const playRandom = () => {
    const list = capabilities?.motions ?? []
    if (!list.length) return
    const reactions = list.filter((m) => !/^idle$/i.test(m.group))
    const pool = reactions.length ? reactions : list
    void play(pool[Math.floor(Math.random() * pool.length)].id)
  }
  playRandomRef.current = playRandom
  const reset = () => {
    setExpression('')
    setActiveMotion('')
    s.setMood('neutral')
    stageRef.current?.reset()
    stageRef.current?.resetModelView()
  }
  // 离开前确认未保存的人设；返回 false 表示用户取消离开。
  const confirmLeave = () =>
    !profileDirty || window.confirm('角色人设还有未保存的更改，确定离开吗？')
  const startChat = () => {
    if (!confirmLeave()) return
    useStudio.getState().selectCharacter(character.id)
    navigate('/')
  }
  const motionCount = capabilities?.motions.length ?? 0
  const expressionCount = capabilities?.expressions.length ?? 0
  const status =
    interaction ||
    (ready
      ? `${motionCount} 个动作 · ${expressionCount} 个表情${capabilities?.supportsMoods ? ' · 支持情绪' : ''}`
      : '正在读取模型资源…')

  return (
    <div className="character-studio-page">
      <header className="page-header character-studio-header">
        <div className="character-studio-heading">
          <Link
            className="character-studio-back"
            to="/characters"
            onClick={(event) => {
              if (!confirmLeave()) event.preventDefault()
            }}
          >
            <ArrowLeft size={16} />
            角色库
          </Link>
          <div>
            <h1>{character.name}</h1>
            <p>模型工作室 · 在舞台上试听动作、表情，并配置背景与氛围。</p>
          </div>
        </div>
        <button className="button primary character-studio-chat" onClick={startChat}>
          用它开始对话
          <ArrowUpRight size={15} />
        </button>
      </header>

      <div className="character-studio-body">
        <section className="character-studio-stage" aria-label="模型预览舞台">
          <div className={`stage stage-${s.stage} ${background ? 'has-media' : ''}`}>
            <StageBackground />
            {!background && <div className="stage-light" aria-hidden="true" />}
            <div className="stage-top">
              <div className="character-pill character-studio-pill">
                <span className="avatar-mini" style={{ background: character.color }}>
                  {character.name[0]}
                </span>
                <span>{character.name}</span>
              </div>
              <div className="stage-actions">
                <span className="character-studio-badge">
                  <span className="status-dot" />
                  {ready ? '实时预览' : '加载中'}
                </span>
              </div>
            </div>
            <div className="model-position">
              <Live2DStage
                key={character.model_path}
                ref={stageRef}
                modelPath={character.model_path}
                actionNames={character.action_names}
                stagePlacement
                onCapabilitiesChange={setCapabilities}
                onInteraction={setInteraction}
              />
            </div>
            <StageEffects effects={s.effects} />
            <StageOverlay />
            <div className="stage-bottom">
              <div className="stage-status" role="status" aria-live="polite">
                <span className="status-dot" />
                {status}
              </div>
              <div className="zoom-controls" role="group" aria-label="画布缩放">
                <button
                  aria-label="缩小"
                  disabled={s.zoom <= zoomMin}
                  onClick={() => s.patch({ zoom: (Math.round(s.zoom * 100) - 10) / 100 })}
                >
                  <Minus size={14} />
                </button>
                <input
                  className="stage-zoom-slider"
                  type="range"
                  min={zoomMin}
                  max={zoomMax}
                  step={0.05}
                  value={s.zoom}
                  aria-label="画布缩放比例"
                  onChange={(event) => s.patch({ zoom: Number(event.target.value) })}
                />
                <button
                  aria-label="放大"
                  disabled={s.zoom >= zoomMax}
                  onClick={() => s.patch({ zoom: (Math.round(s.zoom * 100) + 10) / 100 })}
                >
                  <Plus size={14} />
                </button>
                <span>{Math.round(s.zoom * 100)}%</span>
                <i />
                <button aria-label="重置视图" onClick={reset}>
                  <RotateCcw size={13} />
                </button>
              </div>
            </div>
          </div>
          <p className="character-studio-hint">
            移动指针让角色看向你，轻点角色随机播放动作；右侧动作卡片可以逐个试听。
          </p>
        </section>

        <aside className="character-studio-inspector" aria-label="模型配置面板">
          <div
            className="stage-category-tabs character-studio-tabs"
            role="tablist"
            aria-label="模型配置分类"
            onKeyDown={(event) => {
              const current = tabs.findIndex((item) => item.id === tab)
              const last = tabs.length - 1
              let next: number
              switch (event.key) {
                case 'ArrowLeft':
                  next = current === 0 ? last : current - 1
                  break
                case 'ArrowRight':
                  next = current === last ? 0 : current + 1
                  break
                case 'Home':
                  next = 0
                  break
                case 'End':
                  next = last
                  break
                default:
                  return
              }
              event.preventDefault()
              setTab(tabs[next].id)
              event.currentTarget.querySelectorAll('button')[next]?.focus()
            }}
          >
            {tabs.map(({ id: tabID, name, Icon }) => (
              <button
                key={tabID}
                id={`character-studio-tab-${tabID}`}
                role="tab"
                tabIndex={tab === tabID ? 0 : -1}
                aria-selected={tab === tabID}
                aria-controls={`character-studio-panel-${tabID}`}
                onClick={() => setTab(tabID)}
              >
                <Icon size={15} />
                {name}
                {tabID === 'actions' && ready && <span>{motionCount}</span>}
                {tabID === 'stage' && activeEffects > 0 && <span>{activeEffects}</span>}
                {tabID === 'profile' && profileDirty && (
                  <i className="character-studio-dirty-dot" aria-label="有未保存的更改" />
                )}
              </button>
            ))}
          </div>

          <div
            className="character-studio-scroll"
            role="tabpanel"
            id="character-studio-panel-actions"
            aria-labelledby="character-studio-tab-actions"
            hidden={tab !== 'actions'}
          >
            <section className="character-studio-section">
              <div className="character-controls-label">
                <span>舞台动作</span>
                <small>
                  {ready
                    ? autoPlay
                      ? `自动轮播 · 每 ${autoInterval} 秒`
                      : `${motionCount} 个可用`
                    : '正在读取…'}
                </small>
              </div>
              {!!groups.length && (
                <div className="motion-group-filter" role="group" aria-label="动作分组">
                  {['all', ...groups].map((item) => (
                    <button
                      key={item}
                      className={activeGroup === item ? 'active' : ''}
                      aria-pressed={activeGroup === item}
                      onClick={() => setGroup(item)}
                    >
                      {item === 'all' ? '全部' : item}
                    </button>
                  ))}
                </div>
              )}
              {motions.length ? (
                <div className="motion-gallery">
                  {motions.map((motion) => {
                    const [groupName, ...rest] = motion.label.split(' · ')
                    const playing = activeMotion === motion.id
                    return (
                      <button
                        key={motion.id}
                        className={`motion-card ${playing ? 'playing' : ''}`}
                        disabled={!ready}
                        aria-label={`播放动作 ${motion.label}`}
                        aria-pressed={playing}
                        title={motion.label}
                        onClick={() => void play(motion.id)}
                      >
                        <span className="motion-card-icon" aria-hidden="true">
                          {playing ? (
                            <span className="motion-eq">
                              <i />
                              <i />
                              <i />
                            </span>
                          ) : (
                            <Play size={14} />
                          )}
                        </span>
                        <span className="motion-card-text">
                          <strong>{rest.join(' · ') || groupName}</strong>
                          <small>{playing ? '正在播放' : motion.group || '动作'}</small>
                        </span>
                      </button>
                    )
                  })}
                </div>
              ) : (
                <p className="character-controls-empty">
                  {ready
                    ? groups.length
                      ? '该分组没有动作，切换其他分组看看。'
                      : '当前模型没有自带动作，仍可使用下方情绪与表情。'
                    : '正在读取模型的动作资源…'}
                </p>
              )}
              <div className="character-studio-autoplay">
                <label className="character-studio-switch">
                  <Switch
                    aria-label="自动轮播动作"
                    checked={autoPlay}
                    disabled={!ready || !motionCount}
                    onCheckedChange={(checked) => {
                      setAutoPlay(checked)
                      if (checked) playRandom()
                    }}
                  />
                  自动轮播
                </label>
                <Select
                  value={String(autoInterval)}
                  disabled={!autoPlay}
                  onValueChange={(value) => setAutoInterval(Number(value))}
                >
                  <SelectTrigger size="sm" aria-label="自动轮播间隔" className="h-8 w-[104px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="3">每 3 秒</SelectItem>
                    <SelectItem value="5">每 5 秒</SelectItem>
                    <SelectItem value="8">每 8 秒</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="character-studio-inline">
                <button
                  type="button"
                  className="character-random-button"
                  disabled={!ready || !motionCount}
                  onClick={() => void playRandom()}
                  title="随机播放一个动作"
                >
                  <Shuffle size={14} />
                  随机动作
                </button>
              </div>
              <p className="character-studio-shortcuts">
                <kbd>空格</kbd> 随机动作 · <kbd>1–4</kbd> 情绪 · <kbd>0</kbd> 自然表情 ·{' '}
                <kbd>R</kbd> 重置
              </p>
            </section>

            <section className="character-studio-section">
              <div className="character-controls-label">
                <span>情绪表情</span>
                <small>{capabilities?.supportsMoods ? '通用面部参数' : '模型不支持通用参数'}</small>
              </div>
              <div className="character-mood-grid">
                {moods.map((item) => (
                  <button
                    type="button"
                    key={item.key}
                    disabled={!ready || (item.key !== 'neutral' && !capabilities?.supportsMoods)}
                    className={`character-mood-card ${!expression && s.expression === item.key ? 'active' : ''}`}
                    aria-pressed={!expression && s.expression === item.key}
                    onClick={() => applyMood(item.key)}
                  >
                    <MoodFace mood={item.key} />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="character-studio-section">
              <div className="character-controls-label">
                <span>模型原生表情</span>
                <small>{ready ? `${expressionCount} 个可用` : '正在读取…'}</small>
              </div>
              <div className="expression-gallery">
                <button
                  type="button"
                  className={`expression-card ${!expression ? 'active' : ''}`}
                  aria-pressed={!expression}
                  disabled={!ready}
                  onClick={() => void applyExpression(null)}
                >
                  <Check size={13} />
                  自然
                </button>
                {(capabilities?.expressions ?? []).map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={`expression-card ${expression === item.id ? 'active' : ''}`}
                    aria-pressed={expression === item.id}
                    disabled={!ready}
                    onClick={() => void applyExpression(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
                {ready && !expressionCount && (
                  <p className="character-controls-empty">
                    当前模型没有自带表情，可以使用上方情绪卡片。
                  </p>
                )}
              </div>
            </section>

            <button
              type="button"
              className="character-reset-button"
              disabled={!ready}
              onClick={reset}
            >
              <RotateCcw size={14} />
              重置动作、表情与视图
            </button>
          </div>

          <div
            className="character-studio-scroll"
            role="tabpanel"
            id="character-studio-panel-stage"
            aria-labelledby="character-studio-tab-stage"
            hidden={tab !== 'stage'}
          >
            <BackgroundManager />
            <section className="character-studio-section">
              <div className="effects-heading">
                <span className="panel-label">
                  氛围特效 · {s.effects.filter((effect) => effect.enabled).length} 个已开启
                </span>
                <button
                  disabled={!s.effects.some((effect) => effect.enabled)}
                  onClick={() =>
                    s.patch({
                      effects: s.effects.map((effect) => ({ ...effect, enabled: false })),
                    })
                  }
                >
                  全部关闭
                </button>
              </div>
              <div className="effect-library">
                {effectPresets.map((preset) => {
                  const effect = s.effects.find((item) => item.id === preset.id)
                  const enabled = effect?.enabled ?? false
                  return (
                    <div
                      className={`effect-card effect-card-${preset.id} ${enabled ? 'enabled' : ''}`}
                      key={preset.id}
                    >
                      <div className="effect-card-top">
                        <span className={`effect-preview effect-preview-${preset.id}`}>
                          {preset.icon}
                        </span>
                        <div>
                          <h4>{preset.name}</h4>
                          <p>{preset.description}</p>
                        </div>
                        <Switch
                          aria-label={`启用${preset.name}`}
                          className="ml-auto"
                          checked={enabled}
                          onCheckedChange={(checked) =>
                            setEffect(preset.id, { enabled: checked })
                          }
                        />
                      </div>
                      {enabled && (
                        <label className="effect-intensity">
                          效果强度
                          <input
                            type="range"
                            min={0.1}
                            max={1}
                            step={0.1}
                            value={effect?.intensity ?? 0.5}
                            aria-label={`${preset.name}强度`}
                            onChange={(event) =>
                              setEffect(preset.id, { intensity: Number(event.target.value) })
                            }
                          />
                          <span>{Math.round((effect?.intensity ?? 0.5) * 100)}%</span>
                        </label>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
            <OverlayManager />
          </div>

          <div
            className="character-studio-scroll"
            role="tabpanel"
            id="character-studio-panel-profile"
            aria-labelledby="character-studio-tab-profile"
            hidden={tab !== 'profile'}
          >
            <ProfileEditor character={character} onDirtyChange={setProfileDirty} />
          </div>

          <div className="stage-settings-footer">
            <span className="status-dot" />
            舞台与动作更改即时预览
          </div>
        </aside>
      </div>
      <StageShortcuts
        enabled={ready}
        onRandom={() => void playRandom()}
        onMood={applyMood}
        onReset={reset}
        onNatural={() => void applyExpression(null)}
      />
    </div>
  )
}

/**
 * 全局键盘快捷键：空格随机动作、1–4 切换情绪、0 恢复自然表情、R 重置。
 * 焦点在输入控件或按钮上时不拦截，避免影响正常操作。
 */
function StageShortcuts({
  enabled,
  onRandom,
  onMood,
  onReset,
  onNatural,
}: {
  enabled: boolean
  onRandom: () => void
  onMood: (mood: string) => void
  onReset: () => void
  onNatural: () => void
}) {
  const latest = useRef({ enabled, onRandom, onMood, onReset, onNatural })
  latest.current = { enabled, onRandom, onMood, onReset, onNatural }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const state = latest.current
      if (!state.enabled || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, button, a, [contenteditable="true"]')) return
      if (event.code === 'Space') {
        event.preventDefault()
        state.onRandom()
        return
      }
      if (event.key === 'r' || event.key === 'R') {
        event.preventDefault()
        state.onReset()
        return
      }
      if (event.key === '0') {
        event.preventDefault()
        state.onNatural()
        return
      }
      const index = ['1', '2', '3', '4'].indexOf(event.key)
      if (index >= 0) {
        event.preventDefault()
        state.onMood(moods[index].key)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
  return null
}

/** 角色人设表单：按字节校验名称与提示词，保存后同步到全局角色列表。 */
function ProfileEditor({
  character,
  onDirtyChange,
}: {
  character: Character
  onDirtyChange: (dirty: boolean) => void
}) {
  const [form, setForm] = useState(character)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const encoder = new TextEncoder()
  const name = form.name.trim()
  const nameBytes = encoder.encode(name).length
  const promptBytes = encoder.encode(form.system_prompt).length
  const valid = nameBytes > 0 && nameBytes <= 100 && promptBytes <= 24000
  const dirty =
    form.name !== character.name ||
    form.description !== character.description ||
    form.system_prompt !== character.system_prompt
  // 离开页面前的未保存校验依赖父组件状态；卸载时复位，避免误报。
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  const update = (patch: Partial<Character>) => {
    setForm((current) => ({ ...current, ...patch }))
    setSaved(false)
  }
  const save = async () => {
    if (!valid || saving) return
    setSaving(true)
    setError('')
    try {
      const savedCharacter = await api.saveCharacter({ ...form, name })
      const state = useStudio.getState()
      state.patch({
        characters: state.characters.map((item) =>
          item.id === savedCharacter.id ? savedCharacter : item,
        ),
      })
      setForm(savedCharacter)
      setSaved(true)
      notify('角色人设已保存')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存人设失败')
    } finally {
      setSaving(false)
    }
  }
  // Ctrl/⌘ + S 保存；用 ref 保证监听始终调用最新的表单状态。
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveRef.current()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <form
      className="character-studio-form"
      aria-busy={saving}
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <label className="form-field">
        角色名称
        <input
          maxLength={100}
          disabled={saving}
          value={form.name}
          aria-invalid={nameBytes > 100}
          onChange={(event) => update({ name: event.target.value })}
        />
        {nameBytes > 100 && <small className="character-field-error">名称最多 100 字节。</small>}
      </label>
      <label className="form-field">
        角色介绍
        <input
          maxLength={200}
          disabled={saving}
          value={form.description}
          onChange={(event) => update({ description: event.target.value })}
        />
      </label>
      <label className="form-field">
        系统提示词
        <textarea
          rows={10}
          maxLength={24000}
          disabled={saving}
          value={form.system_prompt}
          aria-invalid={promptBytes > 24000}
          onChange={(event) => update({ system_prompt: event.target.value })}
        />
        <small className={promptBytes > 24000 ? 'character-field-error' : undefined}>
          {promptBytes > 24000
            ? '提示词最多 24,000 字节，请缩短输入。'
            : '描述角色的身份、性格和说话方式。'}
        </small>
      </label>
      {error && (
        <p className="character-form-error" role="alert">
          {error}
          <button aria-label="关闭错误提示" onClick={() => setError('')}>
            <X size={13} />
          </button>
        </p>
      )}
      <div className="character-studio-form-actions">
        <span className="character-studio-saved" role="status">
          {saved && !dirty ? (
            <>
              <Check size={14} /> 已保存
            </>
          ) : (
            dirty && '有未保存的更改'
          )}
        </span>
        <div className="character-studio-save-buttons">
          <small className="character-studio-save-hint">Ctrl/⌘ + S</small>
          <button type="submit" className="button primary" disabled={saving || !valid || !dirty}>
            {saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
            保存人设
          </button>
        </div>
      </div>
      <div className="character-studio-meta">
        <ImageIcon size={14} />
        <span title={character.model_path}>{character.model_path.split('/').slice(-2).join('/')}</span>
      </div>
    </form>
  )
}
