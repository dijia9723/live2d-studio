/** 服务切换始终回读后端；未保存的编辑只在当前页面按服务隔离保留。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { useStudio } from '../store/studio'
import type { LLMProvider, Settings } from '../types/api'

type LLM = Settings['llm']
interface Draft {
  value: LLM
  baseline: LLM
  clear: boolean
}

/** 管理当前服务的加载、草稿、密钥清除和保存后的基线。 */
export function useLLMProfiles(initial: Settings) {
  const [form, setForm] = useState(() => structuredClone(initial))
  const [baseline, setBaseline] = useState(initial.llm)
  const [provider, setProvider] = useState(initial.llm.provider)
  const [profileSaved, setProfileSaved] = useState(initial.llm_profile_saved ?? false)
  const [clearLLM, setClearLLM] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const pending = useRef<AbortController | null>(null)
  const drafts = useRef(new Map<LLMProvider, Draft>())
  const retryTarget = useRef<LLMProvider | undefined>(undefined)

  const load = useCallback(async (target?: LLMProvider) => {
    pending.current?.abort()
    const request = new AbortController()
    pending.current = request
    retryTarget.current = target
    setLoading(true)
    setError('')
    try {
      if (!target) {
        const result = await api.settings(request.signal)
        if (request.signal.aborted) return
        useStudio.getState().patch({ settings: result })
        setForm(structuredClone(result))
        setBaseline(result.llm)
        setProvider(result.llm.provider)
        setProfileSaved(result.llm_profile_saved ?? false)
        setClearLLM(false)
      } else {
        const result = await api.llmProfile(target, request.signal)
        if (request.signal.aborted) return
        const draft = drafts.current.get(target)
        // 只恢复用户实际修改的字段，服务端更新过的其它字段继续使用最新值。
        const changes = draft
          ? Object.fromEntries(
              Object.entries(draft.value).filter(
                ([key, value]) => key !== 'provider' && value !== draft.baseline[key as keyof LLM],
              ),
            )
          : {}
        setForm((current) => ({
          ...current,
          llm: { ...result.llm, ...changes },
          has_llm_key: result.has_llm_key,
          llm_profile_saved: result.saved,
        }))
        setBaseline(result.llm)
        setProvider(target)
        setProfileSaved(result.saved)
        setClearLLM(!!draft?.clear && result.has_llm_key)
      }
    } catch (error) {
      if (!request.signal.aborted)
        setError(error instanceof Error ? error.message : '读取服务配置失败')
    } finally {
      if (!request.signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    return () => pending.current?.abort()
  }, [load])

  const selectProvider = (target: LLMProvider) => {
    if (!loading && !error) {
      if (clearLLM || JSON.stringify(form.llm) !== JSON.stringify(baseline)) {
        drafts.current.set(form.llm.provider, {
          value: structuredClone(form.llm),
          baseline,
          clear: clearLLM,
        })
      } else drafts.current.delete(form.llm.provider)
    }
    setProvider(target)
    void load(target)
  }
  const markSaved = (result: Settings) => {
    drafts.current.delete(result.llm.provider)
    setForm(structuredClone(result))
    setBaseline(result.llm)
    setProvider(result.llm.provider)
    setProfileSaved(result.llm_profile_saved ?? true)
    setClearLLM(false)
  }
  return {
    form,
    setForm,
    baseline,
    provider,
    profileSaved,
    loading,
    error,
    clearLLM,
    setClearLLM,
    selectProvider,
    markSaved,
    retry: () => void load(retryTarget.current),
  }
}
