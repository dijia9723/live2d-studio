import { useState } from 'react'
import {
  Check,
  ChevronRight,
  Cpu,
  ExternalLink,
  Info,
  KeyRound,
  LoaderCircle,
  Plug,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Volume2,
  WandSparkles,
} from 'lucide-react'
import { api } from '../api/client'
import { notify, useStudio } from '../store/studio'
import type { Settings } from '../types/api'

const presets = [
  { name: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: 'DeepSeek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'Ollama', url: 'http://localhost:11434/v1', model: 'qwen3:8b' },
  { name: 'LM Studio', url: 'http://localhost:1234/v1', model: 'local-model' },
]
export default function SettingsPage() {
  const s = useStudio()
  const [form, setForm] = useState<Settings>(() => structuredClone(s.settings!))
  const [tab, setTab] = useState('llm')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [connected, setConnected] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [clearLLM, setClearLLM] = useState(false)
  const [clearSpeech, setClearSpeech] = useState(false)
  const reasoningModel = /^(gpt-5|o[134](?:-|$))/i.test(form.llm.model.trim())
  const llm = (patch: Partial<Settings['llm']>) => {
    setForm((f) => ({ ...f, llm: { ...f.llm, ...patch } }))
    setConnected(false)
    setConnectionError('')
  }
  const speech = (patch: Partial<Settings['speech']>) =>
    setForm((f) => ({ ...f, speech: { ...f.speech, ...patch } }))
  const save = async (test = false) => {
    setSaving(true)
    setConnected(false)
    setConnectionError('')
    try {
      const result = await api.saveSettings({
        ...form,
        clear_llm_key: clearLLM,
        clear_speech_key: clearSpeech,
      })
      s.patch({ settings: result })
      setForm(structuredClone(result))
      setClearLLM(false)
      setClearSpeech(false)
      if (test) {
        setTesting(true)
        await api.testConnection()
        setConnected(true)
        notify('模型服务连接成功')
      } else notify('设置已保存')
    } catch (e) {
      const message = e instanceof Error ? e.message : '保存或测试失败'
      setConnectionError(message)
      notify(message)
    } finally {
      setSaving(false)
      setTesting(false)
    }
  }
  return (
    <>
      <header className="page-header">
        <div>
          <span className="eyebrow">MAKE IT YOURS</span>
          <h1>为陪伴，注入一点智能。</h1>
          <p>连接你喜欢的模型，调节声音，找到最舒服的对话方式。</p>
        </div>
        <button className="button primary" disabled={saving} onClick={() => void save()}>
          {saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}保存设置
        </button>
      </header>
      <div className="settings-content">
        <nav className="settings-tabs" aria-label="设置分类">
          {[
            { id: 'llm', name: '语言模型', icon: Cpu },
            { id: 'speech', name: '语音交互', icon: Volume2 },
            { id: 'agent', name: '智能体', icon: WandSparkles },
          ].map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
            >
              <t.icon size={17} />
              {t.name}
              <ChevronRight size={14} />
            </button>
          ))}
          <div className="privacy-note">
            <ShieldCheck size={23} />
            <strong>数据留在你的设备</strong>
            <p>对话与配置存储在本地。使用云端模型时，消息会发送到你配置的服务。</p>
          </div>
        </nav>
        <div className="settings-main">
          {form.environment_overrides.length > 0 && (
            <div className="info-note">
              <Info size={18} />
              <p>
                部分配置由环境变量覆盖：{form.environment_overrides.join('、')}
                。环境变量的优先级高于保存的设置。
              </p>
            </div>
          )}
          {tab === 'llm' && (
            <>
              <section className="settings-card">
                <div className="card-heading">
                  <span className="card-icon">
                    <Plug size={21} />
                  </span>
                  <div>
                    <h2>连接模型服务</h2>
                    <p>支持任何 OpenAI Chat Completions 兼容接口</p>
                  </div>
                  <span className="tag">API</span>
                </div>
                <div className="preset-grid">
                  {presets.map((p) => (
                    <button
                      className={form.llm.base_url === p.url ? 'active' : ''}
                      key={p.name}
                      onClick={() => llm({ base_url: p.url, model: p.model })}
                    >
                      {p.name}
                      {form.llm.base_url === p.url && <Check size={13} />}
                    </button>
                  ))}
                </div>
                <label className="form-field">
                  服务地址 / Base URL
                  <input
                    type="url"
                    value={form.llm.base_url}
                    onChange={(e) => llm({ base_url: e.target.value })}
                    placeholder="https://api.openai.com/v1"
                  />
                  <small>填写到 /v1 或服务商提供的兼容前缀，勿添加 /chat/completions。</small>
                </label>
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
                {form.has_llm_key && (
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={clearLLM}
                      onChange={(e) => setClearLLM(e.target.checked)}
                    />
                    清除已保存的密钥
                  </label>
                )}
                <label className="form-field">
                  模型名称
                  <input value={form.llm.model} onChange={(e) => llm({ model: e.target.value })} />
                  <small>使用服务商模型 ID，或 Ollama / LM Studio 中已加载的模型名称。</small>
                </label>
                <div className="connection-test">
                  <span className={connected ? 'connected' : 'muted'}>
                    <span className={`status-dot ${connected ? '' : 'gray'}`} />
                    {testing
                      ? '正在验证实际回复能力…'
                      : connected
                        ? '流式回复验证通过'
                        : '保存配置后测试模型连接'}
                  </span>
                  <button
                    className="button ghost"
                    disabled={saving}
                    onClick={() => void save(true)}
                  >
                    {testing ? <LoaderCircle className="spin" size={15} /> : <Plug size={15} />}
                    保存并测试连接
                  </button>
                </div>
                {connectionError && (
                  <p className="connection-error" role="alert">
                    {connectionError}
                  </p>
                )}
              </section>
              <section className="settings-card">
                <div className="card-heading">
                  <span className="card-icon">
                    <SlidersHorizontal size={20} />
                  </span>
                  <div>
                    <h2>回复偏好</h2>
                    <p>让回复更贴合你的期待</p>
                  </div>
                </div>
                <div className="form-row">
                  <label className="form-field">
                    创造性 / Temperature{' '}
                    <span className="range-value">{form.llm.temperature.toFixed(1)}</span>
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
                  <small>历史记录全部保存，此项控制发送给模型的最近消息数量。</small>
                </label>
              </section>
            </>
          )}
          {tab === 'speech' && (
            <section className="settings-card">
              <div className="card-heading">
                <span className="card-icon">
                  <Volume2 size={21} />
                </span>
                <div>
                  <h2>听见你的伙伴</h2>
                  <p>配置语音输入和回复朗读</p>
                </div>
              </div>
              <label className="form-field">
                语音方式
                <select
                  value={form.speech.mode}
                  onChange={(e) => speech({ mode: e.target.value as Settings['speech']['mode'] })}
                >
                  <option value="browser">系统语音（Web Speech）</option>
                  <option value="api">OpenAI 兼容语音 API</option>
                  <option value="off">关闭语音</option>
                </select>
              </label>
              {form.speech.mode === 'browser' && (
                <div className="info-note">
                  <Info size={18} />
                  <p>
                    使用浏览器或系统提供的语音识别与合成。可用性、语种和联网要求取决于 WebView
                    和系统。桌面端推荐使用语音 API。
                  </p>
                </div>
              )}
              {form.speech.mode === 'api' && (
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
                        onChange={(e) => setClearSpeech(e.target.checked)}
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
                    音色 / Voice
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
              <div className="info-note">
                <Volume2 size={18} />
                <p>
                  在聊天区点击麦克风开始录音，再次点击结束。录音识别后会填入输入框，确认内容后发送。点击停止可打断回复与朗读。
                </p>
              </div>
            </section>
          )}
          {tab === 'agent' && (
            <section className="settings-card">
              <div className="card-heading">
                <span className="card-icon">
                  <WandSparkles size={21} />
                </span>
                <div>
                  <h2>Eino 智能体</h2>
                  <p>用 Go 编排每一次对话</p>
                </div>
                <span className="tag">EINO</span>
              </div>
              <div className="agent-flow">
                <span>角色人设</span>
                <i>→</i>
                <span>会话上下文</span>
                <i>→</i>
                <span>Eino</span>
                <i>→</i>
                <span>流式回复</span>
              </div>
              <div className="setting-toggle">
                <div>
                  <strong>启用 ReAct 工具调用</strong>
                  <p>让伙伴查询当前时间，并主动切换 Live2D 表情。</p>
                </div>
                <button
                  role="switch"
                  aria-checked={form.llm.tools_enabled}
                  className={`switch ${form.llm.tools_enabled ? 'on' : ''}`}
                  onClick={() => llm({ tools_enabled: !form.llm.tools_enabled })}
                >
                  <span />
                </button>
              </div>
              <div className="tool-card">
                <span>◷</span>
                <div>
                  <strong>current_time</strong>
                  <p>读取服务端当前时间与时区。</p>
                </div>
                <span className="tag">只读</span>
              </div>
              <div className="tool-card">
                <span>☺</span>
                <div>
                  <strong>set_expression</strong>
                  <p>自然、开心、难过、惊讶四种表情联动。</p>
                </div>
                <span className="tag">舞台</span>
              </div>
              <div className="info-note">
                <Info size={18} />
                <p>
                  需要模型支持 function calling。关闭时仍通过 Eino Chain
                  处理上下文与流式输出。人设可在“角色”页面单独设置。
                </p>
              </div>
              <a
                href="https://www.cloudwego.io/zh/docs/eino/"
                className="text-link"
                target="_blank"
                rel="noreferrer"
              >
                Eino 官方文档
                <ExternalLink size={13} />
              </a>
            </section>
          )}
        </div>
      </div>
    </>
  )
}
