import { useEffect, useRef, useState } from 'react'
import type { CharacterSpeech } from '../types/api'
import TTSWorkbench from './TTSWorkbench'

interface Props {
  value: CharacterSpeech | undefined
  active: boolean
  disabled: boolean
  onChange: (value: CharacterSpeech) => void
}

export default function CharacterSpeechFields({ value, active, disabled, onChange }: Props) {
  const mode = value?.mode ?? 'inherit'
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [previewText, setPreviewText] = useState('你好，很高兴见到你。我们来聊聊今天发生的事吧。')
  const voiceDrafts = useRef<Partial<Record<CharacterSpeech['mode'], CharacterSpeech>>>({})

  useEffect(() => {
    if (!active || mode !== 'browser' || !window.speechSynthesis) return
    const synth = window.speechSynthesis
    const update = () => setVoices(synth.getVoices())
    update()
    synth.addEventListener('voiceschanged', update)
    return () => synth.removeEventListener('voiceschanged', update)
  }, [active, mode])

  return (
    <fieldset className="character-speech-fields" disabled={disabled}>
      <label className="form-field character-voice-mode">
        朗读方式
        <select
          value={mode}
          onChange={(event) => {
            const next = event.target.value as CharacterSpeech['mode']
            if (value) voiceDrafts.current[value.mode] = value
            onChange(voiceDrafts.current[next] ?? { mode: next })
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
      {value?.mode === 'local' && (
        <TTSWorkbench
          options={value.local_tts}
          active={active}
          text={previewText}
          onTextChange={setPreviewText}
          onChange={(local_tts) => onChange({ mode: 'local', local_tts })}
        />
      )}
    </fieldset>
  )
}
