import type { LocalTTSOptions, TTSModel } from '../../types/api'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'

export const ttsTierLabels = { low: '低配', medium: '中配', high: '高配' }

interface Props {
  model: TTSModel
  options: LocalTTSOptions
  disabled: boolean
  onChange: (options: LocalTTSOptions) => void
}

export default function TTSSpeakerFields({ model, options, disabled, onChange }: Props) {
  return (
    <div className="form-row">
      <label className="form-field">
        音色
        <Select
          value={String(options.speaker)}
          disabled={disabled}
          onValueChange={(speaker) => onChange({ ...options, speaker: Number(speaker) })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: model.speaker_max - model.speaker_min + 1 }, (_, index) => {
              const id = model.speaker_min + index
              return (
                <SelectItem key={id} value={String(id)}>
                  {model.speaker_names?.[id] ?? `音色 ${id}`}
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
      </label>
      <label className="form-field">
        <span className="settings-range-label">
          语速 <span>{options.speed.toFixed(2)}×</span>
        </span>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.05}
          value={options.speed}
          disabled={disabled}
          onChange={(event) => onChange({ ...options, speed: Number(event.target.value) })}
        />
      </label>
    </div>
  )
}
