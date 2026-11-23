import { Check } from 'lucide-react'
import StageHTMLFrame from './StageHTMLFrame'
import type { StageHTMLPreset } from './stageHTMLPresets'

export default function StageHTMLPresetGrid({
  label,
  presets,
  selectedID,
  disabled = false,
  onSelect,
}: {
  label: string
  presets: StageHTMLPreset[]
  selectedID: string | null
  disabled?: boolean
  onSelect: (id: string) => void
}) {
  return (
    <div className="stage-html-presets">
      <h4 className="panel-label">{label}</h4>
      <div className="stage-html-preset-grid">
        {presets.map((preset) => (
          <div key={preset.id} className="stage-html-preset">
            <div className="stage-html-preset-preview">
              <StageHTMLFrame title={preset.name} source={preset.source} preview />
            </div>
            <button
              type="button"
              className="stage-html-preset-name"
              aria-pressed={preset.id === selectedID}
              disabled={disabled}
              onClick={() => onSelect(preset.id)}
            >
              {preset.name}
              {preset.id === selectedID && <Check size={12} aria-hidden="true" />}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
