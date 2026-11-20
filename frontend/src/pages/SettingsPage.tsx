/**
 * 页面：设置页。
 * 提供服务配置和本机工作台偏好，负责表单本地编辑、脏检查、
 * 保存设置与测试连接（含“密钥留空即保留”的语义）。
 */
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  AudioLines,
  Brain,
  Calculator,
  Check,
  ChevronRight,
  Clock3,
  Cpu,
  ScanLine,
  ExternalLink,
  Eye,
  Info,
  Keyboard,
  KeyRound,
  LoaderCircle,
  PanelsTopLeft,
  Plug,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Smile,
  Volume2,
  WandSparkles,
  UserRoundPen,
  ListChecks,
  Play,
} from 'lucide-react'
import { api } from '../api/client'
import CharacterMemories from '../components/CharacterMemories'
import HotkeySettings from '../components/HotkeySettings'
import OllamaModels from '../components/OllamaModels'
import StagePlacementSettings from '../components/StagePlacementSettings'
import ScreenWatchSettings from '../components/ScreenWatchSettings'
import TTSWorkbench from '../components/TTSWorkbench'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select'
import { Switch } from '../components/ui/switch'
import { useStudio } from '../store/studio'
import { useLLMProfiles } from '../hooks/useLLMProfiles'
import type { Settings } from '../types/api'

const presets = [
  { name: 'OpenAI', provider: 'openai' },
  { name: 'DeepSeek', provider: 'deepseek' },
  { name: 'Ollama', provider: 'ollama' },
  { name: 'LM Studio', provider: 'lmstudio' },
] as const
const sections = [
  { id: 'llm', name: '语言模型', icon: Cpu },
  { id: 'screen-watch', name: '观看模型', icon: Eye },
  { id: 'speech', name: '语音交互', icon: Volume2 },
  { id: 'tts', name: 'TTS 调试工作台', icon: AudioLines },
  { id: 'agent', name: '智能体', icon: WandSparkles },
  { id: 'stage', name: '舞台布置', icon: PanelsTopLeft },
  { id: 'hotkeys', name: '热键管理', icon: Keyboard },
] as const
type Activity = 'saving' | 'testing'
// 连接测试结果；saved 表示测试失败前更改是否已保存。
type Connection = { status: 'passed' } | { status: 'failed'; message: string; saved: boolean }
const tools = [
  { name: '查询时间', icon: Clock3, description: '获取当前日期和时间，支持指定时区。' },
  { name: '计算', icon: Calculator, description: '计算整数、小数的四则运算，支持括号。' },
  { name: '检索记忆', icon: Brain, description: '按关键词查找当前角色的已保存记忆。' },
  { name: '保存记忆', icon: Brain, description: '按你的明确要求，将事实或偏好保存到当前角色。' },
  { name: '切换表情', icon: Smile, description: '切换自然、开心、难过或惊讶表情。' },
  {
    name: '请求屏幕截图',
    icon: ScanLine,
    description: '在 Windows 桌面客户端提示你框选并发送屏幕区域。',
  },
  {
    name: '查询模型动作',
    icon: ListChecks,
    description: '读取当前模型真实存在的动作和原生表情列表。',
  },
  {
    name: '播放模型动作',
    icon: Play,
    description: '播放指定动作或随机动作，舞台显示实际执行结果。',
  },
  { name: '模型原生表情', icon: Smile, description: '切换模型自带的表情，自动校验表情是否存在。' },
  {
    name: '修改角色设定',
    icon: UserRoundPen,
    description: '按你的要求保存当前角色的名称、自我介绍或人设，可同时修改多项。',
  },
]

export default function SettingsPage() {
  const s = useStudio()
  const [params] = useSearchParams()
  const currentSection = sections.find(({ id }) => params.get('section') === id) ?? sections[0]
  const tab = currentSection.id
  const localSection = tab === 'stage' || tab === 'hotkeys' || tab === 'screen-watch' || tab === 'tts'
  const page = useRef<HTMLDivElement>(null)
  const profiles = useLLMProfiles(s.settings!)
  const { form, setForm, clearLLM, setClearLLM } = profiles
  const [activity, setActivity] = useState<Activity | null>(null)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [connection, setConnection] = useState<Connection | null>(null)
  const [clearSpeech, setClearSpeech] = useState(false)
  const [showMemories, setShowMemories] = useState(false)
  const character = s.characters.find((item) => item.id === s.characterID) ?? s.characters[0]
  // 脏检查：勾选清除密钥或任一设置分组变化都视为有未保存更改。
  const dirty =
    clearLLM ||
    clearSpeech ||
    JSON.stringify(form.llm) !== JSON.stringify(profiles.baseline) ||
    JSON.stringify(form.speech) !== JSON.stringify(s.settings?.speech)
  const switchingService = form.llm.provider !== s.settings?.llm.provider
  const needsSave = dirty || switchingService
  const profileUnavailable = profiles.loading || !!profiles.error
  // 推理模型使用固定采样策略，温度控件对其禁用。
  const isOllama = form.llm.provider === 'ollama'
  const reasoningModel = !isOllama && /^(gpt-5|o[134](?:-|$))/i.test(form.llm.model.trim())
  const connected = connection?.status === 'passed'

  // 切换分区时把页面滚回顶部。
  useEffect(() => {
    page.current?.scrollIntoView({ block: 'start' })
  }, [tab])

  // 修改 LLM 设置会重置连接测试结果。
  const llm = (patch: Partial<Settings['llm']>) => {
    setForm((f) => ({ ...f, llm: { ...f.llm, ...patch } }))
    setConnection(null)
    setSaveError('')
  }
  const speech = (patch: Partial<Settings['speech']>) => {
    setForm((f) => ({ ...f, speech: { ...f.speech, ...patch } }))
    setSaveError('')
  }
  // 提交：按需先保存再测试；测试失败时区分“已保存但连接失败”与保存失败。
  const submit = async (test = false) => {
    if (activity || profileUnavailable || (!needsSave && !test)) return
    let phase: Activity = needsSave ? 'saving' : 'testing'
    setActivity(phase)
    setSaveError('')
    if (test) setConnection(null)
    try {
      if (needsSave) {
        const result = await api.saveSettings({
          ...form,
          clear_llm_key: clearLLM,
          clear_speech_key: clearSpeech,
        })
        s.patch({ settings: result })
        profiles.markSaved(result)
        setClearSpeech(false)
        setSaved(true)
      }
      if (test) {
        phase = 'testing'
        setActivity(phase)
        await api.testConnection()
        setConnection({ status: 'passed' })
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : '请稍后重试。'
      if (phase === 'testing') setConnection({ status: 'failed', message, saved: needsSave })
      else setSaveError(message)
    } finally {
      setActivity(null)
    }
  }
  const connectionTest = (
    <>
      <div className="settings-test-bar">
        <span className={connected ? 'settings-connected' : ''} role="status">
          {connected && <Check size={16} />}
          {activity === 'testing'
            ? '正在等待模型的流式回复…'
            : connected
              ? '流式回复验证通过'
              : '发送一条测试消息，验证模型能否回复。'}
        </span>
        <button
          type="button"
          className="button soft"
          disabled={profileUnavailable}
          onClick={() => void submit(true)}
        >
          {activity ? <LoaderCircle className="spin" size={15} /> : <Plug size={15} />}
          {needsSave ? '保存并测试连接' : '测试连接'}
        </button>
      </div>
      {connection?.status === 'failed' && (
        <p className="settings-alert" role="alert">
          {connection.saved ? '更改已保存，连接测试失败。' : '连接测试失败。'}
          {connection.message}
        </p>
      )}
    </>
  )
  return (
    <div className="settings-page" ref={page}>
      <header className="page-header">
        <div>
          <h1>设置</h1>
          <p>配置模型连接、语音和智能体工具。</p>
        </div>
        <div className="settings-save-actions" hidden={localSection}>
          <span className="settings-save-state" role="status">
            {profiles.loading
              ? '正在读取服务配置…'
              : activity === 'saving'
                ? '正在保存…'
                : activity === 'testing'
                  ? '正在测试连接…'
                  : dirty
                    ? '有未保存的更改'
                    : switchingService
                      ? '保存后启用此服务'
                      : saved
                        ? '设置已保存'
                        : ''}
          </span>
          <button
            className="button primary"
            disabled={!needsSave || activity !== null || profileUnavailable}
            onClick={() => void submit()}
          >
            {activity === 'saving' ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Save size={16} />
            )}
            保存设置
          </button>
        </div>
      </header>
      <div className="settings-layout">
        <aside className="settings-sidebar">
          <nav className="settings-section-nav" aria-label="设置分类">
            {sections.map(({ id, name, icon: Icon }) => (
              <Link key={id} to={`?section=${id}`} aria-current={tab === id ? 'page' : undefined}>
                <Icon size={17} />
                {name}
                <ChevronRight size={15} className="settings-section-arrow" />
              </Link>
            ))}
          </nav>
          <p className="settings-privacy">
            <ShieldCheck size={16} />
            <span>对话和记忆保存在本机。生成回复时，所用内容会发给配置的模型服务。</span>
          </p>
        </aside>
        <fieldset
          className="settings-form"
          disabled={!localSection && activity !== null}
          aria-label={currentSection.name}
        >
          {!localSection && saveError && (
            <p className="settings-alert" role="alert">
              保存失败。{saveError}
            </p>
          )}
          {!localSection && profiles.error && (
            <div className="settings-profile-error" role="alert">
              <span>读取服务配置失败。{profiles.error}</span>
              <button type="button" onClick={profiles.retry}>
                重新读取
              </button>
            </div>
          )}
          {!localSection && form.environment_overrides.length > 0 && (
            <div className="settings-note">
              <Info size={18} />
              <p>这些环境变量优先于应用内设置。{form.environment_overrides.join('、')}</p>
            </div>
          )}
          {tab === 'hotkeys' && <HotkeySettings />}
          {tab === 'screen-watch' && <ScreenWatchSettings />}
          {tab === 'stage' && <StagePlacementSettings />}
          {tab === 'tts' && <TTSWorkbench />}
          {tab === 'llm' && (
            <>
              <section className="settings-card">
                <div className="card-heading">
                  <span className="card-icon">
                    <Plug size={21} />
                  </span>
                  <div>
                    <h2>连接模型服务</h2>
                    <p>连接云端服务，或选择本机 Ollama 中已安装的模型。</p>
                  </div>
                </div>
                <div className="preset-grid">
                  {presets.map((p) => {
                    const active = profiles.provider === p.provider
                    return (
                      <button
                        className={active ? 'active' : ''}
                        aria-pressed={active}
                        key={p.name}
                        onClick={() => {
                          setConnection(null)
                          setSaveError('')
                          setSaved(false)
                          profiles.selectProvider(p.provider)
                        }}
                      >
                        {p.name}
                        {active && <Check size={13} />}
                      </button>
                    )
                  })}
                </div>
                {profiles.loading && (
                  <p className="settings-profile-status" role="status">
                    <LoaderCircle className="spin" size={16} />
                    正在读取已保存的服务配置…
                  </p>
                )}
                {!profileUnavailable && (
                  <>
                    <p className="settings-profile-source">
                      {profiles.profileSaved
                        ? '已读取该服务的已保存配置'
                        : '该服务尚未保存，使用初始配置'}
                      {!dirty && !switchingService && ' · 当前使用中'}
                    </p>
                    <label className="form-field">
                      服务地址 / Base URL
                      <input
                        type="url"
                        value={form.llm.base_url}
                        onChange={(e) => llm({ base_url: e.target.value })}
                        placeholder={
                          isOllama ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1'
                        }
                      />
                      <small>
                        {isOllama
                          ? '填写 Ollama 服务地址，支持根地址、/v1 或 /api。本地服务无需 API Key。'
                          : '填写到 /v1 或服务商提供的兼容前缀，勿添加 /chat/completions。'}
                      </small>
                    </label>
                    {isOllama && (
                      <OllamaModels
                        baseURL={form.llm.base_url}
                        selected={form.llm.model}
                        onSelect={(model) => llm({ model })}
                      />
                    )}
                    {!isOllama && (
                      <label className="form-field">
                        API Key
                        <span className="input-icon">
                          <KeyRound size={16} />
                          <input
                            type="password"
                            autoComplete="off"
                            value={form.llm.api_key}
                            onChange={(e) => llm({ api_key: e.target.value })}
                            placeholder={
                              form.has_llm_key
                                ? '已保存密钥，留空保留'
                                : '输入你的 API Key，本地服务可留空'
                            }
                          />
                        </span>
                      </label>
                    )}
                    {!isOllama && form.has_llm_key && (
                      <label className="checkbox-field">
                        <input
                          type="checkbox"
                          checked={clearLLM}
                          onChange={(e) => {
                            setClearLLM(e.target.checked)
                            setConnection(null)
                            setSaveError('')
                          }}
                        />
                        清除已保存的密钥
                      </label>
                    )}
                    <label className="form-field">
                      模型名称
                      <input
                        value={form.llm.model}
                        onChange={(e) => llm({ model: e.target.value })}
                      />
                      <small>
                        {isOllama
                          ? '点击上方模型即可填入，也可以手动填写完整名称（包含标签）。'
                          : '使用服务商模型 ID，或 LM Studio 中已加载的模型名称。'}
                      </small>
                    </label>
                    {connectionTest}
                  </>
                )}
              </section>
              {!profileUnavailable && (
                <section className="settings-card">
                  <div className="card-heading">
                    <span className="card-icon">
                      <SlidersHorizontal size={20} />
                    </span>
                    <div>
                      <h2>回复参数</h2>
                      <p>调整生成长度和发送给模型的会话上下文。</p>
                    </div>
                  </div>
                  <div className="form-row">
                    <label className="form-field">
                      <span className="settings-range-label">
                        创造性 / Temperature
                        <span>{form.llm.temperature.toFixed(1)}</span>
                      </span>
                      <input
                        type="range"
                        min="0"
                        max="2"
                        step="0.1"
                        disabled={reasoningModel}
                        value={form.llm.temperature}
                        onChange={(e) => llm({ temperature: Number(e.target.value) })}
                      />
                      <small>
                        {reasoningModel
                          ? '此推理模型使用固定采样策略，保存时将自动适配。'
                          : '越低越严谨，越高越有想象力。'}
                      </small>
                    </label>
                    <label className="form-field">
                      回复长度 / Max Tokens
                      <input
                        type="number"
                        min={1}
                        max={131072}
                        value={form.llm.max_tokens}
                        onChange={(e) => llm({ max_tokens: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                  <label className="form-field narrow">
                    上下文消息数
                    <input
                      type="number"
                      min={2}
                      max={200}
                      step={2}
                      value={form.llm.context_messages}
                      onChange={(e) => llm({ context_messages: Number(e.target.value) })}
                    />
                    <small>
                      设置发送给模型的历史消息数量上限。较大的历史文字和图片会优先保留近期内容。
                    </small>
                  </label>
                </section>
              )}
            </>
          )}
          {tab === 'speech' && (
            <section className="settings-card">
              <div className="card-heading">
                <span className="card-icon">
                  <Volume2 size={21} />
                </span>
                <div>
                  <h2>全局语音交互</h2>
                  <p>设置语音识别与默认朗读方式。各角色可在角色配置中选择自己的音色。</p>
                </div>
              </div>
              <label className="form-field">
                默认语音方式
                <Select
                  value={form.speech.mode}
                  onValueChange={(value) => speech({ mode: value as Settings['speech']['mode'] })}
                >
                  <SelectTrigger aria-label="语音方式" className="h-[42px] text-[14px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="browser">系统语音（Web Speech）</SelectItem>
                    <SelectItem value="api">OpenAI 兼容语音 API</SelectItem>
                    <SelectItem value="off">关闭语音</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              {form.speech.mode === 'browser' && (
                <div className="settings-note">
                  <Info size={18} />
                  <p>
                    使用浏览器或系统提供的语音识别与合成。可用性、语种和联网要求取决于 WebView
                    和系统。桌面端推荐使用语音 API。
                  </p>
                </div>
              )}
              {form.speech.mode !== 'off' && (
                <>
                  <label className="form-field">
                    语音服务地址
                    <input
                      type="url"
                      value={form.speech.base_url}
                      onChange={(e) => speech({ base_url: e.target.value })}
                    />
                  </label>
                  <label className="form-field">
                    语音 API Key
                    <input
                      type="password"
                      autoComplete="off"
                      value={form.speech.api_key}
                      placeholder={form.has_speech_key ? '已保存，留空保留' : '语音服务的独立密钥'}
                      onChange={(e) => speech({ api_key: e.target.value })}
                    />
                  </label>
                  {form.has_speech_key && (
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={clearSpeech}
                        onChange={(e) => {
                          setClearSpeech(e.target.checked)
                          setSaveError('')
                        }}
                      />
                      清除语音密钥
                    </label>
                  )}
                  <div className="form-row">
                    <label className="form-field">
                      语音识别 / ASR
                      <input
                        value={form.speech.asr_model}
                        onChange={(e) => speech({ asr_model: e.target.value })}
                      />
                    </label>
                    <label className="form-field">
                      语音合成 / TTS
                      <input
                        value={form.speech.tts_model}
                        onChange={(e) => speech({ tts_model: e.target.value })}
                      />
                    </label>
                  </div>
                  <label className="form-field">
                    默认 API 音色
                    <input
                      value={form.speech.voice}
                      onChange={(e) => speech({ voice: e.target.value })}
                    />
                  </label>
                </>
              )}
              <label className="form-field">
                语言
                <input
                  value={form.speech.language}
                  placeholder="zh-CN"
                  onChange={(e) => speech({ language: e.target.value })}
                />
              </label>
              <div className="settings-note">
                <Volume2 size={18} />
                <p>
                  在聊天区点击麦克风开始录音，再次点击结束。录音识别后会填入输入框，确认内容后发送。点击停止可打断回复与朗读。
                  <Link className="settings-text-link" to="?section=tts">
                    打开 TTS 调试工作台 <ChevronRight size={14} />
                  </Link>
                </p>
              </div>
            </section>
          )}
          {tab === 'agent' && (
            <>
              <section className="settings-card">
                <div className="card-heading">
                  <span className="card-icon">
                    <WandSparkles size={21} />
                  </span>
                  <div>
                    <h2>工具调用</h2>
                    <p>运行状态会显示在回复旁，并保存在对话记录里。</p>
                  </div>
                </div>
                <div className="setting-toggle">
                  <div>
                    <strong id="agent-tools-label">启用智能体工具</strong>
                    <p id="agent-tools-help">使用支持工具调用的模型，保存后即可在对话中使用。</p>
                  </div>
                  <Switch
                    aria-labelledby="agent-tools-label"
                    aria-describedby="agent-tools-help"
                    checked={form.llm.tools_enabled}
                    disabled={profileUnavailable}
                    onCheckedChange={(checked) => llm({ tools_enabled: checked })}
                  />
                </div>
                <ul className="settings-tool-grid" aria-label="可调用的工具">
                  {tools.map(({ name, icon: Icon, description }) => (
                    <li key={name}>
                      <Icon size={18} aria-hidden="true" />
                      <div>
                        <strong>{name}</strong>
                        <p>{description}</p>
                      </div>
                    </li>
                  ))}
                </ul>
                {connectionTest}
                <a
                  href="https://www.cloudwego.io/zh/docs/eino/"
                  className="settings-text-link"
                  target="_blank"
                  rel="noreferrer"
                >
                  Eino 官方文档 <ExternalLink size={13} />
                </a>
              </section>
              <section className="settings-card">
                <div className="card-heading">
                  <span className="card-icon">
                    <Brain size={21} />
                  </span>
                  <div>
                    <h2>角色记忆</h2>
                    <p>不同会话会参考同一角色最近更新的 8 条记忆。启用工具后可以检索更早的记忆。</p>
                  </div>
                </div>
                {character && (
                  <button
                    type="button"
                    className="button soft"
                    onClick={() => setShowMemories(true)}
                  >
                    管理 {character.name} 的记忆 <ChevronRight size={15} />
                  </button>
                )}
              </section>
            </>
          )}
        </fieldset>
      </div>
      {showMemories && character && (
        <CharacterMemories character={character} onClose={() => setShowMemories(false)} />
      )}
    </div>
  )
}
