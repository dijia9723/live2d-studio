import { useEffect, useRef, useState } from 'react'
import { AudioLines, Download, Info, LoaderCircle, Play, RefreshCw, Square } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { LocalTTSOptions, TTSCatalog } from '../types/api'
import TTSSpeakerFields, { ttsTierLabels } from './TTSSpeakerFields'

export default function TTSWorkbench() {
  const [catalog, setCatalog] = useState<TTSCatalog>()
  const [catalogError, setCatalogError] = useState('')
  const [refreshing, setRefreshing] = useState(true)
  const [revision, setRevision] = useState(0)
  const [draft, setDraft] = useState<LocalTTSOptions>()
  const [text, setText] = useState('你好，欢迎来到直播间。今天想和大家聊点什么呢？')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ url: string; seconds: number; model: string }>()
  const request = useRef<AbortController>(null)

  useEffect(() => {
    const controller = new AbortController()
    setRefreshing(true)
    setCatalogError('')
    api
      .ttsModels(controller.signal)
      .then(setCatalog, (err: Error) => {
        if (!controller.signal.aborted) setCatalogError(err.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setRefreshing(false)
      })
    return () => controller.abort()
  }, [revision])

  useEffect(() => () => request.current?.abort(), [])
  useEffect(
    () => () => {
      if (result) URL.revokeObjectURL(result.url)
    },
    [result],
  )

  const fallback = catalog?.models.find((item) => item.installed) ?? catalog?.models[0]
  const options =
    draft ??
    (fallback && {
      model: fallback.id,
      speaker: fallback.default_speaker,
      speed: 1,
    })
  const model = catalog?.models.find((item) => item.id === options?.model)
  const ready = !!(catalog?.runtime_installed && model?.installed)
  const length = Array.from(text).length
  const maxLength = catalog?.max_text_length ?? 1000

  const change = (next: LocalTTSOptions) => {
    setDraft(next)
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
    <section className="settings-card tts-workbench">
      <div className="card-heading">
        <span className="card-icon">
          <AudioLines size={21} />
        </span>
        <div>
          <h2>TTS 调试工作台</h2>
          <p>选择本地模型和音色，合成 WAV 并试听。</p>
        </div>
        <button
          type="button"
          className="button soft tts-refresh"
          disabled={refreshing}
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
      {catalog && (
        <>
          <div className="preset-grid tts-models" role="group" aria-label="本地合成模型">
            {catalog.models.map((item) => (
              <button
                type="button"
                key={item.id}
                disabled={busy}
                className={item.id === model?.id ? 'active' : undefined}
                aria-pressed={item.id === model?.id}
                onClick={() =>
                  change({
                    model: item.id,
                    speaker: item.default_speaker,
                    speed: options?.speed ?? 1,
                  })
                }
              >
                <strong>
                  {ttsTierLabels[item.tier]} · {item.name}
                </strong>
                <small>
                  {item.language} · {item.installed ? '已安装' : '待安装'}
                </small>
              </button>
            ))}
          </div>
          {!ready && (
            <div className="settings-note">
              <Info size={17} />
              <p>
                {catalog.runtime_installed ? '所选模型待安装。' : '本地推理环境待安装。'}
                在项目根目录运行 <code>pwsh -File scripts/install-tts.ps1</code>，完成后刷新模型。
              </p>
            </div>
          )}
          {model && options && (
            <>
              <TTSSpeakerFields model={model} options={options} disabled={busy} onChange={change} />
              <label className="form-field">
                <span className="settings-range-label">
                  朗读文本{' '}
                  <span>
                    {length} / {maxLength}
                  </span>
                </span>
                <textarea
                  rows={4}
                  value={text}
                  disabled={busy}
                  onChange={(e) => {
                    setText(e.target.value)
                    setResult(undefined)
                    setError('')
                  }}
                />
              </label>
              <div className="settings-test-bar">
                <span role="status">{result && `合成完成 · ${result.seconds.toFixed(2)} 秒`}</span>
                {busy ? (
                  <button
                    type="button"
                    className="button soft"
                    onClick={() => {
                      request.current?.abort()
                      request.current = null
                      setBusy(false)
                    }}
                  >
                    <LoaderCircle className="spin" size={16} /> <Square size={14} /> 取消合成
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button primary"
                    disabled={!ready || !text.trim() || length > maxLength}
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
                <div className="tts-result">
                  <audio src={result.url} controls aria-label="合成结果" />
                  <a className="button soft" href={result.url} download={`${result.model}.wav`}>
                    <Download size={16} /> 下载 WAV
                  </a>
                </div>
              )}
              <div className="settings-test-bar tts-apply">
                <span>在角色配置中设置日常朗读音色。</span>
                <Link className="button soft" to="/characters">
                  前往角色配置
                </Link>
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}
