import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Download, Play, RefreshCw, Square } from 'lucide-react'
import { api } from '../../api/client'
import type { LocalTTSOptions, TTSCatalog } from '../../types/api'
import TTSSpeakerFields, { ttsTierLabels } from './TTSSpeakerFields'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { Textarea } from '../ui/textarea'

interface Props {
  options: LocalTTSOptions | undefined
  active: boolean
  text: string
  onTextChange: (text: string) => void
  onChange: (options: LocalTTSOptions) => void
}

export default function TTSWorkbench({ options, active, text, onTextChange, onChange }: Props) {
  const titleID = useId()
  const textID = useId()
  const [catalog, setCatalog] = useState<TTSCatalog>()
  const [catalogError, setCatalogError] = useState('')
  const [refreshing, setRefreshing] = useState(true)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ url: string; seconds: number; model: string }>()
  const request = useRef<AbortController>(null)
  const player = useRef<HTMLAudioElement>(null)
  const resultArea = useRef<HTMLDivElement>(null)

  const cancel = useCallback(() => {
    request.current?.abort()
    request.current = null
    setBusy(false)
  }, [])

  useEffect(() => {
    if (active) return
    cancel()
    player.current?.pause()
  }, [active, cancel])

  useEffect(() => {
    const controller = new AbortController()
    setRefreshing(true)
    setCatalogError('')
    api
      .ttsModels(controller.signal)
      .then(
        (next) => {
          if (!controller.signal.aborted) setCatalog(next)
        },
        (err: Error) => {
          if (!controller.signal.aborted) setCatalogError(err.message)
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setRefreshing(false)
      })
    return () => controller.abort()
  }, [revision])

  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    if (!result) return
    resultArea.current?.scrollIntoView({ block: 'nearest' })
    return () => URL.revokeObjectURL(result.url)
  }, [result])

  const model = catalog?.models.find((item) => item.id === options?.model)
  const ready = !!(catalog?.runtime_installed && model?.installed)
  const needsInstall =
    catalog &&
    (!catalog.runtime_installed ||
      !catalog.models.some((item) => item.installed) ||
      (options && !model?.installed))
  const length = Array.from(text).length
  const maxLength = catalog?.max_text_length ?? 1000

  const change = (next: LocalTTSOptions) => {
    onChange(next)
    setError('')
    setResult(undefined)
  }

  const synthesize = async () => {
    if (!options || !ready || request.current || !text.trim() || length > maxLength) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setResult(undefined)
    setError('')
    const start = performance.now()
    try {
      const audio = await api.synthesizeLocal(text, options, controller.signal)
      if (!controller.signal.aborted) {
        setResult({
          url: URL.createObjectURL(audio),
          seconds: (performance.now() - start) / 1000,
          model: options.model,
        })
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : '语音合成失败')
    } finally {
      if (request.current === controller) {
        request.current = null
        if (!controller.signal.aborted) setBusy(false)
      }
    }
  }

  return (
    <section className="tts-workbench" aria-labelledby={titleID}>
      <h3 id={titleID} className="sr-only">
        TTS 调试工作台
      </h3>
      <div className="tts-options">
        <div className="tts-workbench-bar">
          <h4>声音参数</h4>
          <button
            type="button"
            className="button ghost"
            disabled={refreshing || busy}
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw size={15} className={refreshing ? 'spin' : undefined} /> 刷新模型
          </button>
        </div>
        {catalogError && (
          <p className="settings-alert" role="alert">
            {catalogError}
          </p>
        )}
        <label className="form-field">
          本地模型
          <Select
            value={options?.model ?? ''}
            disabled={!catalog || refreshing || busy}
            onValueChange={(id) => {
              const selected = catalog?.models.find((item) => item.id === id)
              if (selected)
                change({
                  model: selected.id,
                  speaker: selected.default_speaker,
                  speed: options?.speed ?? 1,
                })
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder={refreshing ? '读取本地模型…' : '选择模型'} />
            </SelectTrigger>
            <SelectContent>
              {options && !model && (
                <SelectItem value={options.model}>{options.model}</SelectItem>
              )}
              {catalog?.models.map((item) => (
                <SelectItem
                  key={item.id}
                  value={item.id}
                  disabled={!item.installed || !catalog.runtime_installed}
                >
                  {ttsTierLabels[item.tier]} · {item.name}
                  {item.installed ? '' : '（待安装）'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {model && <small>{model.language}</small>}
        </label>
        {needsInstall && (
          <p className="settings-note tts-install-note">
            {catalog.runtime_installed ? '模型待安装。' : '本地推理环境待安装。'}
            运行 <code>pwsh -File scripts/install-tts.ps1</code> 后刷新模型。
          </p>
        )}
        {model && options && (
          <TTSSpeakerFields model={model} options={options} disabled={busy} onChange={change} />
        )}
      </div>
      <div className="tts-preview">
        <div className="tts-workbench-bar">
          <label htmlFor={textID}>试听文本</label>
          <span
            id={`${textID}-count`}
            className={length > maxLength ? 'tts-text-over-limit' : undefined}
          >
            {length} / {maxLength}
          </span>
        </div>
        <div className="form-field tts-preview-text">
          <Textarea
            id={textID}
            rows={4}
            value={text}
            disabled={busy}
            aria-invalid={length > maxLength}
            aria-describedby={`${textID}-count`}
            onChange={(event) => {
              onTextChange(event.target.value)
              setResult(undefined)
              setError('')
            }}
          />
        </div>
        <div className="tts-workbench-bar tts-preview-actions">
          <span role="status">
            {busy
              ? '正在合成…'
              : result
                ? `合成完成 · ${result.seconds.toFixed(2)} 秒`
                : !refreshing && catalog?.runtime_installed && !options
                  ? '选择模型后可试听'
                  : ''}
          </span>
          {busy ? (
            <button type="button" className="button soft" onClick={cancel}>
              <Square size={14} /> 取消合成
            </button>
          ) : (
            <button
              type="button"
              className="button soft"
              disabled={!ready || refreshing || !text.trim() || length > maxLength}
              onClick={() => void synthesize()}
            >
              <Play size={16} /> 合成试听
            </button>
          )}
        </div>
        {error && (
          <p className="settings-alert" role="alert">
            {error}
          </p>
        )}
        {result && (
          <div className="tts-result" ref={resultArea}>
            <audio ref={player} src={result.url} controls autoPlay aria-label="试听音频" />
            <a className="button ghost" href={result.url} download={`${result.model}.wav`}>
              <Download size={16} /> 下载 WAV
            </a>
          </div>
        )}
      </div>
    </section>
  )
}
