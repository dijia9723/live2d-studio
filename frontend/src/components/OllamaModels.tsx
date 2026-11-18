/** 文件职责：从当前填写的 Ollama 地址读取模型；请求可取消，旧地址响应不覆盖新地址。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, HardDrive, LoaderCircle, RefreshCw, Search } from 'lucide-react'
import { api } from '../api/client'
import type { OllamaModel } from '../types/api'

function modelSize(bytes: number) {
  if (!bytes) return ''
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`
}

export default function OllamaModels({
  baseURL,
  selected,
  onSelect,
}: {
  baseURL: string
  selected: string
  onSelect: (name: string) => void
}) {
  const [models, setModels] = useState<OllamaModel[]>([])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
  const [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null)
  const refresh = useCallback(async () => {
    pending.current?.abort()
    if (!baseURL.trim()) {
      setStatus('idle')
      return
    }
    const request = new AbortController()
    pending.current = request
    setStatus('loading')
    setError('')
    try {
      const result = await api.ollamaModels(baseURL, request.signal)
      if (!request.signal.aborted) {
        setModels(result)
        setStatus('loaded')
      }
    } catch (error) {
      if (!request.signal.aborted) {
        setModels([])
        setError(error instanceof Error ? error.message : '读取模型列表失败')
        setStatus('error')
      }
    }
  }, [baseURL])
  useEffect(() => {
    setModels([])
    setQuery('')
    setStatus(baseURL.trim() ? 'loading' : 'idle')
    setError('')
    const timer = setTimeout(() => void refresh(), 500)
    return () => {
      clearTimeout(timer)
      pending.current?.abort()
    }
  }, [refresh, baseURL])
  const filtered = models.filter((item) =>
    item.name.toLowerCase().includes(query.trim().toLowerCase()),
  )
  return (
    <section className="ollama-models" aria-label="Ollama 已安装模型">
      <div className="ollama-models-heading">
        <span>
          <HardDrive size={15} />
          已安装模型{status === 'loaded' && <small>{models.length}</small>}
        </span>
        <button
          type="button"
          disabled={status === 'loading' || !baseURL.trim()}
          onClick={() => void refresh()}
          aria-label="刷新 Ollama 模型列表"
        >
          {status === 'loading' ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          刷新
        </button>
      </div>
      {status === 'loading' && (
        <p className="ollama-status" role="status">
          正在读取本地模型…
        </p>
      )}
      {status === 'error' && (
        <p className="settings-alert" role="alert">
          {error}
        </p>
      )}
      {status === 'idle' && <p className="ollama-status">填写 Ollama 服务地址后即可读取模型。</p>}
      {status === 'loaded' && !models.length && (
        <div className="ollama-empty">
          <p>服务已连接，还没有安装模型。</p>
          <p>
            在终端执行 <code>ollama pull 模型名称</code>，完成后刷新此列表。
          </p>
        </div>
      )}
      {status === 'loaded' && models.length > 0 && (
        <>
          <label className="ollama-search">
            <Search size={14} />
            <input
              aria-label="搜索 Ollama 模型"
              value={query}
              placeholder="搜索已安装模型"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="ollama-model-list" role="group" aria-label="选择本地模型">
            {filtered.map((model) => (
              <button
                key={model.name}
                type="button"
                aria-label={`选择模型 ${model.name}`}
                aria-pressed={selected === model.name}
                onClick={() => onSelect(model.name)}
              >
                <div>
                  <strong>{model.name}</strong>
                  <span>
                    {[
                      model.details.parameter_size,
                      model.details.quantization_level,
                      modelSize(model.size),
                    ]
                      .filter(Boolean)
                      .join(' · ') || '本地模型'}
                  </span>
                </div>
                {selected === model.name ? (
                  <span className="ollama-selected">
                    <Check size={14} />
                    已选择
                  </span>
                ) : (
                  <span className="ollama-select-label">选择</span>
                )}
              </button>
            ))}
            {!filtered.length && <p className="ollama-status">没有匹配的模型。</p>}
          </div>
          {selected && !models.some((item) => item.name === selected) && (
            <p className="ollama-model-hint">当前模型不在列表中，请检查名称，或在安装后刷新。</p>
          )}
        </>
      )}
      <p className="ollama-model-hint">
        选择支持对话的模型，保存后用于聊天。工具调用和图片识别取决于模型能力。
      </p>
    </section>
  )
}
