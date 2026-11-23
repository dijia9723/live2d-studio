import { useEffect, useRef, useState } from 'react'
import type { CharacterSpeech } from '../../types/api'
import TTSWorkbench from '../speech/TTSWorkbench'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'

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
        <Select
          value={mode}
          onValueChange={(next) => {
            const nextMode = next as CharacterSpeech['mode']
            if (value) voiceDrafts.current[value.mode] = value
            onChange(voiceDrafts.current[nextMode] ?? { mode: nextMode })
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">跟随全局设置</SelectItem>
            <SelectItem value="browser">系统语音</SelectItem>
            <SelectItem value="api">语音 API</SelectItem>
            <SelectItem value="local">本地 TTS</SelectItem>
          </SelectContent>
        </Select>
      </label>
      {value?.mode === 'browser' && (
        <label className="form-field">
          系统音色
          <Select
            value={value.voice || '__default__'}
            onValueChange={(voice) =>
              onChange({ mode: 'browser', voice: voice === '__default__' ? '' : voice })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">系统默认音色</SelectItem>
              {value.voice && !voices.some((voice) => voice.voiceURI === value.voice) && (
                <SelectItem value={value.voice}>{value.voice}（当前系统不可用）</SelectItem>
              )}
              {voices.map((voice) => (
                <SelectItem key={voice.voiceURI} value={voice.voiceURI}>
                  {voice.name} · {voice.lang}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
