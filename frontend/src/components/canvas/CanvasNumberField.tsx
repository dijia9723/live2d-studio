/** 文件职责：可完整输入数字、失焦后校验提交的画布数字字段。 */
import { useEffect, useRef, useState } from 'react'

/** 输入期间保留草稿，避免计数跳动或范围约束打断输入。 */
export default function CanvasNumberField({
  label,
  value,
  onChange,
  min = -1e12,
  max = 1e12,
  step = 'any',
}: {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number | 'any'
}) {
  const [draft, setDraft] = useState(String(value))
  const [focused, setFocused] = useState(false)
  const dirty = useRef(false)
  useEffect(() => {
    if (!focused) setDraft(String(Math.round(value * 1e6) / 1e6))
  }, [value, focused])
  return (
    <label className="canvas-field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onFocus={() => {
          dirty.current = false
          setFocused(true)
        }}
        onChange={(event) => {
          dirty.current = true
          setDraft(event.target.value)
        }}
        onBlur={() => {
          const parsed = draft.trim() ? Number(draft) : NaN
          const next =
            dirty.current && Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : value
          setDraft(String(next))
          setFocused(false)
          if (next !== value) onChange(next)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
      />
    </label>
  )
}
