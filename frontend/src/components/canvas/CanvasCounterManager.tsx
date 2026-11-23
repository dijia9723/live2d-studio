/** 文件职责：共享计数数据的新增、手动增减、自动累加和绑定使用情况。 */
import { Minus, Pause, Play, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useCanvas } from '../../store/canvas'
import { useCanvasClock } from '../../hooks/useCanvasClock'
import { counterValue, formatCounter, maxCanvasCounters } from '../../utils/canvas'
import CanvasNumberField from './CanvasNumberField'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'

/** 同一计数可供多个组件引用，删除前要求解除所有组件绑定。 */
export default function CanvasCounterManager() {
  const s = useCanvas()
  const now = useCanvasClock(s.counters)
  return (
    <div className="canvas-counter-manager">
      <div className="canvas-section-heading">
        <div>
          <h3>计数数据</h3>
          <p>一份数据可以同时显示在多个组件里。</p>
        </div>
        <button
          className="canvas-small-button"
          disabled={s.counters.length >= maxCanvasCounters}
          onClick={s.addCounter}
        >
          <Plus size={14} />
          新建
        </button>
      </div>
      {!s.counters.length && (
        <div className="canvas-empty">还没有计数数据，先新建一项，再绑定到组件。</div>
      )}
      {s.counters.map((counter) => {
        const usage = s.widgets.filter((widget) =>
          widget.bindings.some((binding) => binding.counterID === counter.id),
        ).length
        const value = counterValue(counter, now)
        return (
          <section
            className="canvas-counter-card"
            key={counter.id}
            aria-label={counter.name || '未命名计数'}
          >
            <div className="canvas-counter-top">
              <input
                className="canvas-counter-name"
                aria-label="计数名称"
                maxLength={40}
                value={counter.name}
                placeholder="计数名称"
                onChange={(event) => s.updateCounter(counter.id, { name: event.target.value })}
              />
              <button
                className="canvas-icon-button danger"
                title={usage ? `被 ${usage} 个组件使用，请先解除绑定` : '删除计数'}
                aria-label={`删除 ${counter.name}`}
                disabled={!!usage}
                onClick={() => s.removeCounter(counter.id)}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="canvas-counter-readout">
              <button
                className="canvas-icon-button"
                aria-label={`${counter.name} 减少 ${counter.step}`}
                onClick={() => s.adjustCounter(counter.id, -1)}
              >
                <Minus size={16} />
              </button>
              <output>{formatCounter(value)}</output>
              <button
                className="canvas-icon-button"
                aria-label={`${counter.name} 增加 ${counter.step}`}
                onClick={() => s.adjustCounter(counter.id, 1)}
              >
                <Plus size={16} />
              </button>
            </div>
            <label className="canvas-field">
              <span>更新方式</span>
              <Select
                value={counter.mode}
                onValueChange={(mode) =>
                  s.updateCounter(counter.id, { mode: mode as 'auto' | 'manual' })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">手动计数</SelectItem>
                  <SelectItem value="auto">自动累加</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <div className="canvas-field-grid">
              <CanvasNumberField
                label="当前值"
                value={value}
                onChange={(value) => s.updateCounter(counter.id, { value })}
              />
              <CanvasNumberField
                label="每次增减"
                value={counter.step}
                min={0.000001}
                onChange={(step) => s.updateCounter(counter.id, { step })}
              />
              <CanvasNumberField
                label="重置到"
                value={counter.initialValue}
                onChange={(initialValue) => s.updateCounter(counter.id, { initialValue })}
              />
              {counter.mode === 'auto' && (
                <CanvasNumberField
                  label="累加间隔（秒）"
                  value={counter.intervalSeconds}
                  min={1}
                  max={86400}
                  onChange={(intervalSeconds) => s.updateCounter(counter.id, { intervalSeconds })}
                />
              )}
            </div>
            <div className="canvas-counter-actions">
              {counter.mode === 'auto' && (
                <button
                  className={`canvas-small-button ${counter.running ? 'is-running' : ''}`}
                  onClick={() => s.toggleCounter(counter.id)}
                >
                  {counter.running ? <Pause size={13} /> : <Play size={13} />}
                  {counter.running ? '暂停累加' : '开始累加'}
                </button>
              )}
              <button className="canvas-small-button" onClick={() => s.resetCounter(counter.id)}>
                <RotateCcw size={13} />
                重置
              </button>
              <span>{usage ? `${usage} 个组件引用` : '尚未绑定'}</span>
            </div>
          </section>
        )
      })}
      {!!s.counters.length && (
        <p className="canvas-help">
          自动累加按实际经过时间计算；刷新或关闭页面后仍会续算，点击暂停即可停止。
        </p>
      )}
    </div>
  )
}
