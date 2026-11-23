import { useState } from 'react'
import { Move, PanelsTopLeft } from 'lucide-react'
import { useStudio } from '../../store/studio'
import {
  defaultModelDragLimits,
  defaultModelZoomLimits,
  modelZoomPercentBounds,
  validModelDragLimits,
  validModelZoomLimits,
  type ModelDragLimits,
} from '../../types/stage'

export default function StagePlacementSettings() {
  return (
    <>
      <ModelZoomRange />
      <ModelDragRange />
    </>
  )
}

function ModelZoomRange() {
  const limits = useStudio((s) => s.modelZoomLimits)
  const setLimits = useStudio((s) => s.setModelZoomLimits)
  const [minimum, setMinimum] = useState(String(limits.min))
  const [maximum, setMaximum] = useState(String(limits.max))
  const [feedback, setFeedback] = useState<'invalid' | 'saved' | null>(null)
  const min = Number(minimum)
  const max = Number(maximum)
  const allowed = modelZoomPercentBounds
  const changed = min !== limits.min || max !== limits.max

  return (
    <section className="settings-card">
      <div className="card-heading">
        <span className="card-icon">
          <PanelsTopLeft size={21} aria-hidden="true" />
        </span>
        <div>
          <h2>模型缩放范围</h2>
          <p>滚轮和缩放按钮使用同一范围。模型位置和当前缩放比例会随舞台模板保存。</p>
        </div>
      </div>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          if (!validModelZoomLimits({ min, max })) {
            setFeedback('invalid')
            return
          }
          setLimits({ min, max })
          setFeedback('saved')
        }}
      >
        <div className="form-row">
          <label className="form-field">
            最小缩放（%）
            <input
              type="number"
              min={allowed.min}
              max={allowed.max}
              value={minimum}
              aria-invalid={feedback === 'invalid' || undefined}
              onChange={(event) => {
                setMinimum(event.target.value)
                setFeedback(null)
              }}
            />
          </label>
          <label className="form-field">
            最大缩放（%）
            <input
              type="number"
              min={allowed.min}
              max={allowed.max}
              value={maximum}
              aria-invalid={feedback === 'invalid' || undefined}
              onChange={(event) => {
                setMaximum(event.target.value)
                setFeedback(null)
              }}
            />
          </label>
        </div>
        {feedback === 'invalid' && (
          <p className="settings-alert" role="alert">
            请输入 {allowed.min}% 到 {allowed.max}% 之间的整数，最小缩放不能大于最大缩放。
          </p>
        )}
        <div className="settings-range-actions">
          <button type="submit" className="button primary" disabled={!changed}>
            保存范围
          </button>
          <button
            type="button"
            className="button ghost"
            onClick={() => {
              setMinimum(String(defaultModelZoomLimits.min))
              setMaximum(String(defaultModelZoomLimits.max))
              setLimits(defaultModelZoomLimits)
              setFeedback('saved')
            }}
          >
            恢复默认范围
          </button>
          {feedback === 'saved' && (
            <span className="settings-save-state" role="status">
              已保存
            </span>
          )}
        </div>
      </form>
    </section>
  )
}

const dragFields = [
  { id: 'left', label: '左边界（%）' },
  { id: 'right', label: '右边界（%）' },
  { id: 'top', label: '上边界（%）' },
  { id: 'bottom', label: '下边界（%）' },
] as const

function ModelDragRange() {
  const limits = useStudio((s) => s.modelDragLimits)
  const setLimits = useStudio((s) => s.setModelDragLimits)
  const [draft, setDraft] = useState<Partial<Record<keyof ModelDragLimits, string>>>({})
  const [feedback, setFeedback] = useState<'invalid' | 'saved' | null>(null)
  const value = (id: keyof ModelDragLimits) => draft[id] ?? String(limits[id])
  const changed = dragFields.some(({ id }) => value(id) !== String(limits[id]))

  return (
    <section className="settings-card">
      <div className="card-heading">
        <span className="card-icon">
          <Move size={21} aria-hidden="true" />
        </span>
        <div>
          <h2>模型拖拽范围</h2>
          <p>
            边界按模型绘制区域的宽高计算。左侧和上侧是 0%，右侧和下侧是 100%。 可用负值或超过 100%
            的值将模型中心拖到边缘之外。
          </p>
        </div>
      </div>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          const next = {
            left: Number.parseFloat(value('left')),
            right: Number.parseFloat(value('right')),
            top: Number.parseFloat(value('top')),
            bottom: Number.parseFloat(value('bottom')),
          }
          if (!validModelDragLimits(next)) {
            setFeedback('invalid')
            return
          }
          setLimits(next)
          setDraft({})
          setFeedback('saved')
        }}
      >
        <div className="form-row">
          {dragFields.map(({ id, label }) => (
            <label className="form-field" key={id}>
              {label}
              <input
                type="number"
                value={value(id)}
                aria-invalid={feedback === 'invalid' || undefined}
                onChange={(event) => {
                  setDraft({ ...draft, [id]: event.target.value })
                  setFeedback(null)
                }}
              />
            </label>
          ))}
        </div>
        {feedback === 'invalid' && (
          <p className="settings-alert" role="alert">
            请输入整数。左边界须小于或等于右边界，上边界须小于或等于下边界。
          </p>
        )}
        <div className="settings-range-actions">
          <button type="submit" className="button primary" disabled={!changed}>
            保存拖拽范围
          </button>
          <button
            type="button"
            className="button ghost"
            onClick={() => {
              setLimits(defaultModelDragLimits)
              setDraft({})
              setFeedback('saved')
            }}
          >
            恢复默认拖拽范围
          </button>
          {feedback === 'saved' && (
            <span className="settings-save-state" role="status">
              已保存
            </span>
          )}
        </div>
      </form>
    </section>
  )
}
