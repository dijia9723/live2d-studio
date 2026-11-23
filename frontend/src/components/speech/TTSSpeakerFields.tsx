/**
 * 文件职责：本地 TTS 的音色与语速字段。
 * 音色编号范围由模型配置决定，语速在 0.5×–2× 之间可调。
 */
import type { LocalTTSOptions, TTSModel } from '../../types/api'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'

/** 本地 TTS 模型档位的中文名。 */
export const ttsTierLabels = { low: '低配', medium: '中配', high: '高配' }

/** 音色/语速字段属性。 */
interface Props {
  model: TTSModel
  options: LocalTTSOptions
  disabled: boolean
  onChange: (options: LocalTTSOptions) => void
}

/** 本地 TTS 音色与语速选择。 */
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
            {/* 音色编号是闭区间，长度需 +1；无名称时回退为编号。 */}
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
