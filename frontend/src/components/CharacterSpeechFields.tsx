import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { CharacterSpeech, TTSCatalog } from '../types/api'
import TTSSpeakerFields, { ttsTierLabels } from './TTSSpeakerFields'

interface Props {
  value: CharacterSpeech | undefined
  disabled: boolean
  onChange: (value: CharacterSpeech) => void
}

export default function CharacterSpeechFields({ value, disabled, onChange }: Props) {
  const mode = value?.mode ?? 'inherit'
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [catalog, setCatalog] = useState<TTSCatalog>()
  const [catalogError, setCatalogError] = useState('')

  useEffect(() => {
    if (mode !== 'browser' || !window.speechSynthesis) return
    const synth = window.speechSynthesis
    const update = () => setVoices(synth.getVoices())
    update()
    synth.addEventListener('voiceschanged', update)
    return () => synth.removeEventListener('voiceschanged', update)
  }, [mode])

  useEffect(() => {
    if (mode !== 'local') return
    const controller = new AbortController()
    setCatalogError('')
    api.ttsModels(controller.signal).then(setCatalog, (error: Error) => {
      if (!controller.signal.aborted) setCatalogError(error.message)
    })
    return () => controller.abort()
  }, [mode])

  const local = value?.mode === 'local' ? value.local_tts : undefined
  const selected = catalog?.models.find((model) => model.id === local?.model)
  const needsInstall =
    catalog &&
    (!catalog.runtime_installed ||
      !catalog.models.some((model) => model.installed) ||
      (selected && !selected.installed))

  return (
    <fieldset className="character-speech-fields" disabled={disabled}>
      <legend>角色语音</legend>
      <label className="form-field">
        朗读方式
        <select
          value={mode}
          onChange={(event) => {
            const next = event.target.value as CharacterSpeech['mode']
            onChange({ mode: next })
          }}
        >
          <option value="inherit">跟随全局设置</option>
          <option value="browser">系统语音</option>
          <option value="api">语音 API</option>
          <option value="local">本地 TTS</option>
        </select>
      </label>
      {value?.mode === 'browser' && (
        <label className="form-field">
          系统音色
          <select
            value={value.voice ?? ''}
            onChange={(event) => onChange({ mode: 'browser', voice: event.target.value })}
          >
            <option value="">系统默认音色</option>
            {value.voice && !voices.some((voice) => voice.voiceURI === value.voice) && (
              <option value={value.voice}>{value.voice}（当前系统不可用）</option>
            )}
            {voices.map((voice) => (
              <option key={voice.voiceURI} value={voice.voiceURI}>
                {voice.name} · {voice.lang}
              </option>
            ))}
          </select>
          {voices.length === 0 && <small>当前环境没有返回可选的系统音色。</small>}
        </label>
      )}
      {value?.mode === 'api' && (
        <label className="form-field">
          API 音色
          <input
            value={value.voice ?? ''}
            maxLength={160}
            placeholder="语音服务支持的音色名称"
            onChange={(event) => onChange({ mode: 'api', voice: event.target.value })}
          />
          <small>留空时使用全局语音服务的默认音色。</small>
        </label>
      )}
      {mode === 'local' && (
        <>
          <label className="form-field">
            本地模型
            <select
              value={local?.model ?? ''}
              disabled={!catalog}
              onChange={(event) => {
                const model = catalog?.models.find((item) => item.id === event.target.value)
                if (model)
                  onChange({
                    mode: 'local',
                    local_tts: { model: model.id, speaker: model.default_speaker, speed: 1 },
                  })
              }}
            >
              <option value="" disabled>
                {catalog ? '选择模型' : '读取本地模型'}
              </option>
              {local && !selected && <option value={local.model}>{local.model}</option>}
              {catalog?.models.map((model) => (
                <option
                  key={model.id}
                  value={model.id}
                  disabled={!model.installed || !catalog.runtime_installed}
                >
                  {ttsTierLabels[model.tier]} · {model.name}
                  {model.installed ? '' : '（待安装）'}
                </option>
              ))}
            </select>
            {catalogError && <small role="alert">{catalogError}</small>}
            {needsInstall && (
              <small>
                请在 <Link to="/settings?section=tts">TTS 调试工作台</Link> 查看安装状态。
              </small>
            )}
          </label>
          {local && selected && (
            <TTSSpeakerFields
              model={selected}
              options={local}
              disabled={disabled}
              onChange={(local_tts) => onChange({ mode: 'local', local_tts })}
            />
          )}
        </>
      )}
    </fieldset>
  )
}
