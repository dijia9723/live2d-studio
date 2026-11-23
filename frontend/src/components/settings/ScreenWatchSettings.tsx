/**
 * 文件职责：屏幕观察的模型配置。
 * 分别为「快速理解」（文字 OCR）与「视觉理解」（裁图）选择服务与模型，
 * 复用语言模型的地址与密钥，模型名留空即关闭该能力。
 */
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { LLMProvider, ScreenWatchSettings as ModelSettings } from '../../types/api'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'

const providers: { id: LLMProvider; label: string }[] = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'ollama', label: 'Ollama' },
  { id: 'lmstudio', label: 'LM Studio' },
]
// 两种用途可分别配置：文字摘要便宜，视觉理解按需触发。
const usages = [
  { key: 'fast', title: '快速理解', hint: '可选。屏幕文字较多时，提取与问题有关的内容。' },
  { key: 'vision', title: '视觉理解', hint: '可选。需要理解图标、颜色或图表时，用一张裁图回答。' },
] as const

/** 观看模型设置卡片。 */
export default function ScreenWatchSettings() {
  const [form, setForm] = useState<ModelSettings>({})
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const request = new AbortController()
    void api
      .screenWatchSettings(request.signal)
      .then((data) => {
        if (!request.signal.aborted) {
          setForm(data)
          setReady(true)
        }
      })
      .catch(() => {
        if (!request.signal.aborted) setError('读取观看模型配置失败')
      })
    return () => request.abort()
  }, [])

  async function save() {
    setSaving(true)
    setError('')
    setMessage('')
    const models: ModelSettings = {}
    for (const { key } of usages) {
      const value = form[key]
      // 只提交填写了模型名的项，留空的用途视为关闭。
      if (value?.model.trim()) models[key] = { ...value, model: value.model.trim() }
    }
    try {
      setForm(await api.saveScreenWatchSettings(models))
      setMessage('已保存观看模型')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存观看模型失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-card">
      <h2>观看模型</h2>
      <p>角色对话使用「语言模型」中的当前配置。观看模型复用所选服务的地址和密钥。</p>
      <form
        className="screen-watch-settings"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        {usages.map(({ key, title, hint }) => (
          <fieldset key={key} disabled={!ready || saving}>
            <legend>{title}</legend>
            <p>{hint}</p>
            <label>
              服务
              <Select
                value={form[key]?.provider ?? 'openai'}
                onValueChange={(provider) => {
                  setForm((current) => ({
                    ...current,
                    [key]: { provider: provider as LLMProvider, model: current[key]?.model ?? '' },
                  }))
                  setMessage('')
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {providers.map(({ id, label }) => (
                    <SelectItem key={id} value={id}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label>
              模型名称
              <input
                value={form[key]?.model ?? ''}
                placeholder="留空关闭"
                maxLength={200}
                onChange={(event) => {
                  const model = event.target.value
                  setForm((current) => ({
                    ...current,
                    [key]: { provider: current[key]?.provider ?? 'openai', model },
                  }))
                  setMessage('')
                }}
              />
            </label>
          </fieldset>
        ))}
        <div>
          <button type="submit" className="button primary" disabled={!ready || saving}>
            {saving ? '保存中…' : '保存观看模型'}
          </button>
          {message && <span role="status">{message}</span>}
          {error && <span role="alert">{error}</span>}
        </div>
      </form>
    </section>
  )
}
