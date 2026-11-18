/** 文件职责：选中画布元素的外观、位置、HTML 模板和多计数绑定编辑。 */
import { useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Copy, Plus, Trash2, Upload } from 'lucide-react'
import type { CanvasWidget } from '../types/canvas'
import { useCanvas } from '../store/canvas'
import {
  bindingAliasPattern,
  defaultCounterHTML,
  doubleCounterHTML,
  maxCanvasCounters,
  maxCanvasWidgets,
  maxWidgetHTML,
  templateAliases,
} from '../utils/canvas'
import CanvasNumberField from './CanvasNumberField'

/** 所有外观和绑定变更即时预览，位置值以画布百分比表示。 */
export default function CanvasWidgetEditor({ widget }: { widget: CanvasWidget }) {
  const s = useCanvas()
  const upload = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const update = (patch: Partial<CanvasWidget>) => s.updateWidget(widget.id, patch)
  const missing = templateAliases(widget.html).filter(
    (alias) =>
      !widget.bindings.some(
        (binding) =>
          binding.alias === alias && s.counters.some((counter) => counter.id === binding.counterID),
      ),
  )
  const badAliases = widget.bindings.some(
    (binding, index) =>
      !bindingAliasPattern.test(binding.alias) ||
      widget.bindings.some(
        (other, otherIndex) => otherIndex !== index && other.alias === binding.alias,
      ),
  )

  const applyTemplate = (double: boolean) => {
    const aliases = double ? ['count', 'second'] : ['count']
    while (
      useCanvas.getState().counters.length < aliases.length &&
      useCanvas.getState().counters.length < maxCanvasCounters
    )
      s.addCounter()
    const counters = useCanvas.getState().counters
    const bindings = aliases.map(
      (alias, index) =>
        widget.bindings.find(
          (binding) =>
            binding.alias === alias && counters.some((counter) => counter.id === binding.counterID),
        ) ?? { id: crypto.randomUUID(), alias, counterID: counters[index]?.id ?? counters[0].id },
    )
    update({ html: double ? doubleCounterHTML : defaultCounterHTML, bindings })
    setError('')
  }
  const importHTML = async (file?: File) => {
    if (!file) return
    if (file.size > maxWidgetHTML) {
      setError('HTML 文件请控制在 50 KB 内。')
      return
    }
    const targetID = widget.id
    try {
      const html = await file.text()
      if (html.length > maxWidgetHTML) {
        setError('HTML 内容不能超过 50,000 个字符。')
        return
      }
      s.updateWidget(targetID, { html })
      setError('')
    } catch {
      setError('读取 HTML 文件失败，请重新选择。')
    }
  }
  return (
    <section className="canvas-widget-editor" aria-label="元素设置">
      <div className="canvas-section-heading">
        <h3>{widget.kind === 'title' ? '标题设置' : 'HTML 组件设置'}</h3>
        <span>即时预览</span>
      </div>
      <label className="canvas-field">
        <span>元素名称</span>
        <input
          maxLength={60}
          value={widget.name}
          onChange={(event) => update({ name: event.target.value })}
        />
      </label>
      {widget.kind === 'title' ? (
        <>
          <label className="canvas-field">
            <span>标题文字</span>
            <textarea
              rows={3}
              maxLength={1000}
              value={widget.text}
              onChange={(event) => update({ text: event.target.value })}
            />
          </label>
          <div className="canvas-field-grid">
            <CanvasNumberField
              label="字号（px）"
              value={widget.fontSize}
              min={8}
              max={160}
              onChange={(fontSize) => update({ fontSize })}
            />
            <label className="canvas-field">
              <span>文字颜色</span>
              <input
                type="color"
                value={widget.color}
                onChange={(event) => update({ color: event.target.value })}
              />
            </label>
          </div>
          <div className="canvas-field-grid">
            <label className="canvas-field">
              <span>对齐</span>
              <select
                value={widget.align}
                onChange={(event) => update({ align: event.target.value as CanvasWidget['align'] })}
              >
                <option value="left">左对齐</option>
                <option value="center">居中</option>
                <option value="right">右对齐</option>
              </select>
            </label>
            <label className="canvas-check-field">
              <input
                type="checkbox"
                checked={widget.bold}
                onChange={(event) => update({ bold: event.target.checked })}
              />
              粗体
            </label>
          </div>
        </>
      ) : (
        <>
          <div className="canvas-template-tools">
            <select
              aria-label="套用示例模板"
              value=""
              onChange={(event) => {
                if (event.target.value) applyTemplate(event.target.value === 'double')
              }}
            >
              <option value="">套用示例模板…</option>
              <option value="single">单计数卡片</option>
              <option value="double">双计数卡片</option>
            </select>
            <button className="canvas-small-button" onClick={() => upload.current?.click()}>
              <Upload size={13} />
              导入 HTML
            </button>
            <input
              ref={upload}
              hidden
              type="file"
              accept=".html,.htm,text/html"
              onChange={(event) => {
                void importHTML(event.target.files?.[0])
                event.target.value = ''
              }}
            />
          </div>
          <label className="canvas-field">
            <span>自定义 HTML / CSS</span>
            <textarea
              className="canvas-code"
              rows={11}
              maxLength={maxWidgetHTML}
              spellCheck={false}
              value={widget.html}
              onChange={(event) => {
                update({ html: event.target.value })
                setError('')
              }}
            />
          </label>
          <p className="canvas-help">
            可粘贴 HTML 和 &lt;style&gt; 样式，支持 CSS 动画。脚本不执行。套用示例会替换当前 HTML
            与绑定。
          </p>
          {error && (
            <p className="canvas-field-error" role="alert">
              {error}
            </p>
          )}
          <div className="canvas-section-heading">
            <h4>计数绑定</h4>
            <button
              className="canvas-small-button"
              disabled={widget.bindings.length >= 16 || !s.counters.length}
              onClick={() => {
                let index = 1
                while (widget.bindings.some((binding) => binding.alias === `count${index}`)) index++
                update({
                  bindings: [
                    ...widget.bindings,
                    {
                      id: crypto.randomUUID(),
                      alias: `count${index}`,
                      counterID: s.counters[0].id,
                    },
                  ],
                })
              }}
            >
              <Plus size={13} />
              绑定数据
            </button>
          </div>
          {widget.bindings.map((binding) => (
            <div className="canvas-binding-row" key={binding.id}>
              <input
                aria-label="模板变量名"
                placeholder="变量名"
                value={binding.alias}
                maxLength={32}
                aria-invalid={
                  !bindingAliasPattern.test(binding.alias) ||
                  widget.bindings.some(
                    (other) => other.id !== binding.id && other.alias === binding.alias,
                  )
                }
                onChange={(event) =>
                  update({
                    bindings: widget.bindings.map((item) =>
                      item.id === binding.id ? { ...item, alias: event.target.value } : item,
                    ),
                  })
                }
              />
              <select
                aria-label={`${binding.alias || '变量'} 的计数数据`}
                value={binding.counterID}
                onChange={(event) =>
                  update({
                    bindings: widget.bindings.map((item) =>
                      item.id === binding.id ? { ...item, counterID: event.target.value } : item,
                    ),
                  })
                }
              >
                <option value="">选择计数…</option>
                {s.counters.map((counter) => (
                  <option key={counter.id} value={counter.id}>
                    {counter.name || '未命名计数'}
                  </option>
                ))}
              </select>
              <button
                className="canvas-icon-button danger"
                aria-label={`解除 ${binding.alias} 绑定`}
                onClick={() =>
                  update({ bindings: widget.bindings.filter((item) => item.id !== binding.id) })
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {!s.counters.length && <p className="canvas-help">先在“计数数据”中新建计数。</p>}
          <p className="canvas-help">
            例如 <code>{'{{count}}'}</code> 显示数值，<code>{'{{count.label}}'}</code> 显示名称，
            <code>{'{{count.raw}}'}</code> 显示不含千分位的数值。可绑定多个变量。
          </p>
          {badAliases && (
            <p className="canvas-field-error">
              变量名须以英文字母开头，仅含字母、数字和下划线，且不能重复。
            </p>
          )}
          {!!missing.length && (
            <p className="canvas-field-error" role="status">
              未绑定：{missing.join('、')}，画布上显示为 —。
            </p>
          )}
        </>
      )}
      <div className="canvas-section-heading">
        <h4>位置与大小</h4>
        <span>画布百分比</span>
      </div>
      <div className="canvas-field-grid">
        <CanvasNumberField
          label="X（%）"
          value={widget.x}
          min={0}
          max={100 - widget.width}
          onChange={(x) => update({ x })}
        />
        <CanvasNumberField
          label="Y（%）"
          value={widget.y}
          min={0}
          max={100 - widget.height}
          onChange={(y) => update({ y })}
        />
        <CanvasNumberField
          label="宽度（%）"
          value={widget.width}
          min={8}
          max={100}
          onChange={(width) => update({ width })}
        />
        <CanvasNumberField
          label="高度（%）"
          value={widget.height}
          min={5}
          max={100}
          onChange={(height) => update({ height })}
        />
      </div>
      <label className="canvas-field canvas-opacity">
        <span>
          不透明度 <output>{Math.round(widget.opacity * 100)}%</output>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={widget.opacity}
          onChange={(event) => update({ opacity: Number(event.target.value) })}
        />
      </label>
      <div className="canvas-editor-actions">
        <button
          className="canvas-small-button"
          disabled={s.widgets.at(-1)?.id === widget.id}
          onClick={() => s.moveWidget(widget.id, 1)}
        >
          <ArrowUp size={13} />
          上移一层
        </button>
        <button
          className="canvas-small-button"
          disabled={s.widgets[0]?.id === widget.id}
          onClick={() => s.moveWidget(widget.id, -1)}
        >
          <ArrowDown size={13} />
          下移一层
        </button>
        <button
          className="canvas-small-button"
          disabled={s.widgets.length >= maxCanvasWidgets}
          onClick={() => s.duplicateWidget(widget.id)}
        >
          <Copy size={13} />
          复制
        </button>
      </div>
    </section>
  )
}
