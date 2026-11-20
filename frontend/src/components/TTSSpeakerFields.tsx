import type { LocalTTSOptions, TTSModel } from '../types/api'

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
        <select
          value={options.speaker}
          disabled={disabled}
          onChange={(event) => onChange({ ...options, speaker: Number(event.target.value) })}
        >
          {Array.from({ length: model.speaker_max - model.speaker_min + 1 }, (_, index) => {
            const id = model.speaker_min + index
            return (
              <option key={id} value={id}>
                {model.speaker_names?.[id] ?? `音色 ${id}`}
              </option>
            )
          })}
        </select>
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
