import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { http } from '../../api/client'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'

export interface ModelSelection {
  model_provider: string
  model_name: string
}

interface ModelOption {
  provider: string
  model: string
  available: boolean
}

interface SessionModel extends Partial<ModelSelection> {
  effective: ModelOption
}

const endpoint = (id: string) => `/coding/sessions/${encodeURIComponent(id)}/model`
const providers: Record<string, string> = {
  openai: 'OpenAI 兼容',
  deepseek: 'DeepSeek',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
}
const errorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : '读取模型配置失败'

export function CodingModelFields({
  value,
  onChange,
  disabled,
  defaultLabel = '跟随全局模型',
}: {
  value: ModelSelection
  onChange: (value: ModelSelection) => void
  disabled?: boolean
  defaultLabel?: string
}) {
  const [catalog, setCatalog] = useState<ModelOption[]>()
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    http
      .get<{ data: { providers: ModelOption[] } }>('/coding/models', { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setCatalog(result.data.data.providers)
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause))
      })
    return () => controller.abort()
  }, [])
  return (
    <>
      <label className="coding-model-field">
        模型服务
        <Select
          value={value.model_provider || '__default__'}
          disabled={disabled || !catalog}
          onValueChange={(provider) => {
            if (provider === '__default__') {
              onChange({ model_provider: '', model_name: '' })
              return
            }
            const option = catalog?.find((item) => item.provider === provider)
            onChange({
              model_provider: option?.provider || '',
              model_name: option?.model || '',
            })
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">{defaultLabel}</SelectItem>
            {catalog?.map((item) => (
              <SelectItem value={item.provider} key={item.provider} disabled={!item.available}>
                {providers[item.provider] || item.provider}
                {!item.available && '（待配置）'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {value.model_provider && (
        <label className="coding-model-field">
          模型名称
          <input
            required
            maxLength={200}
            value={value.model_name}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, model_name: event.target.value })}
          />
        </label>
      )}
      {error && (
        <p className="coding-alert" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

export default function CodingSessionModel({
  session,
  disabled,
}: {
  session: string
  disabled?: boolean
}) {
  const [current, setCurrent] = useState<SessionModel>()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<ModelSelection>({ model_provider: '', model_name: '' })

  useEffect(() => {
    const controller = new AbortController()
    http
      .get<{ data: SessionModel }>(endpoint(session), { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setCurrent(result.data.data)
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause))
      })
    return () => controller.abort()
  }, [session])

  async function save() {
    setBusy(true)
    setError('')
    try {
      const result = await http.put<{ data: SessionModel }>(endpoint(session), draft)
      setCurrent(result.data.data)
      setOpen(false)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button
        type="button"
        className="coding-model"
        aria-label="切换会话模型"
        disabled={disabled}
        title={current?.effective.model || '会话模型'}
        onClick={() => {
          setDraft({
            model_provider: current?.model_provider || '',
            model_name: current?.model_name || '',
          })
          setOpen(true)
        }}
      >
        {current?.effective.model || '会话模型'}
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next)
        }}
      >
        <DialogContent className="pi-plugin-dialog coding-model-dialog">
          <DialogTitle>会话模型</DialogTitle>
          <DialogDescription>此设置应用于当前会话，并随会话分支继承。</DialogDescription>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <CodingModelFields value={draft} onChange={setDraft} disabled={busy} />
            {error && (
              <p className="coding-alert" role="alert">
                {error}
              </p>
            )}
            <div className="coding-actions">
              <Link className="coding-button" to="/coding/settings">
                配置模型服务
              </Link>
              <button
                className="coding-button"
                disabled={busy || (Boolean(draft.model_provider) && !draft.model_name.trim())}
              >
                保存
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
