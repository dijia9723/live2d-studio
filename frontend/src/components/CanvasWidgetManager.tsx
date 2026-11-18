/** 文件职责：画布元素列表、布局编辑开关及元素 / 计数数据面板。 */
import {
  Braces,
  Check,
  Eye,
  EyeOff,
  LockKeyhole,
  MousePointer2,
  Plus,
  Trash2,
  Type,
  Undo2,
  UnlockKeyhole,
} from 'lucide-react'
import { useCanvas } from '../store/canvas'
import { maxCanvasWidgets } from '../utils/canvas'
import CanvasCounterManager from './CanvasCounterManager'
import CanvasWidgetEditor from './CanvasWidgetEditor'

export default function CanvasWidgetManager() {
  const s = useCanvas()
  const tab = s.managerTab
  const setTab = s.setManagerTab
  const selected = s.widgets.find((widget) => widget.id === s.selectedID)
  const add = (kind: 'title' | 'html') => {
    s.addWidget(kind)
    setTab('widgets')
  }
  return (
    <div className="canvas-widget-manager">
      <div className="canvas-section-heading">
        <div>
          <h3>自由布置画布</h3>
          <p>标题、HTML 组件和共享计数，随手组合。</p>
        </div>
      </div>
      <div className="canvas-add-actions">
        <button
          className="canvas-small-button"
          disabled={s.widgets.length >= maxCanvasWidgets}
          onClick={() => add('title')}
        >
          <Type size={15} />
          添加标题
        </button>
        <button
          className="canvas-small-button"
          disabled={s.widgets.length >= maxCanvasWidgets}
          onClick={() => add('html')}
        >
          <Plus size={15} />
          计数组件
        </button>
        <button
          className={`canvas-small-button canvas-edit-toggle ${s.editing ? 'active' : ''}`}
          aria-pressed={s.editing}
          onClick={() => s.setEditing(!s.editing)}
        >
          {s.editing ? <Check size={14} /> : <MousePointer2 size={14} />}
          {s.editing ? '完成' : '编辑布局'}
        </button>
      </div>
      <div className="canvas-manager-tabs" role="group" aria-label="画布管理分类">
        <button aria-pressed={tab === 'widgets'} onClick={() => setTab('widgets')}>
          元素 <span>{s.widgets.length}</span>
        </button>
        <button aria-pressed={tab === 'data'} onClick={() => setTab('data')}>
          计数数据 <span>{s.counters.length}</span>
        </button>
      </div>
      {tab === 'data' ? (
        <CanvasCounterManager />
      ) : (
        <>
          {!s.widgets.length && (
            <div className="canvas-empty">
              <Braces size={25} />
              <strong>让画布多一点内容</strong>
              <p>添加标题或计数卡片，再拖到你喜欢的位置。</p>
            </div>
          )}
          <div className="canvas-widget-list">
            {[...s.widgets].reverse().map((widget) => (
              <div
                className={`canvas-widget-row ${s.selectedID === widget.id ? 'active' : ''}`}
                key={widget.id}
              >
                <button
                  className="canvas-widget-select"
                  aria-pressed={s.selectedID === widget.id}
                  onClick={() => s.selectWidget(widget.id)}
                >
                  {widget.kind === 'title' ? <Type size={15} /> : <Braces size={15} />}
                  <span>{widget.name || '未命名元素'}</span>
                </button>
                <button
                  className="canvas-icon-button"
                  title={widget.visible ? '隐藏' : '显示'}
                  aria-label={`${widget.visible ? '隐藏' : '显示'} ${widget.name}`}
                  aria-pressed={widget.visible}
                  onClick={() => s.updateWidget(widget.id, { visible: !widget.visible })}
                >
                  {widget.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
                <button
                  className="canvas-icon-button"
                  title={widget.locked ? '解锁' : '锁定位置'}
                  aria-label={`${widget.locked ? '解锁' : '锁定'} ${widget.name}`}
                  aria-pressed={widget.locked}
                  onClick={() => s.updateWidget(widget.id, { locked: !widget.locked })}
                >
                  {widget.locked ? <LockKeyhole size={14} /> : <UnlockKeyhole size={14} />}
                </button>
                <button
                  className="canvas-icon-button danger"
                  aria-label={`删除 ${widget.name}`}
                  onClick={() => s.removeWidget(widget.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
          {s.removed && (
            <button
              className="canvas-undo canvas-small-button"
              disabled={s.widgets.length >= maxCanvasWidgets}
              onClick={s.undoRemove}
            >
              <Undo2 size={13} />
              撤销删除「{s.removed.widget.name}」
            </button>
          )}
          {selected && <CanvasWidgetEditor key={selected.id} widget={selected} />}
          {!!s.widgets.length && (
            <p className="canvas-help">
              列表顶部显示在最前面。完成编辑后，组件不会阻挡角色交互。布局与计数自动保存在当前设备。
            </p>
          )}
        </>
      )}
    </div>
  )
}
