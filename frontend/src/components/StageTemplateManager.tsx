/** 文件职责：为当前舞台命名保存，管理、恢复与更新本机模板。 */
import { useState } from 'react'
import { Check, CopyPlus, Pencil, Play, Save, Trash2, Undo2, X } from 'lucide-react'
import { maxStageTemplates, useStageTemplates } from '../store/stageTemplates'
import { useStudio } from '../store/studio'
import { useCanvas } from '../store/canvas'
import { stageAspectPresets } from '../types/stage'

const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

export default function StageTemplateManager() {
  const s = useStageTemplates()
  const aspect = useStudio((state) => state.aspect)
  const widgets = useCanvas((state) => state.widgets)
  const counters = useCanvas((state) => state.counters)
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [updating, setUpdating] = useState<string | null>(null)
  return (
    <div className="stage-templates">
      <div className="stage-template-intro">
        <span className="stage-template-intro-icon">
          <CopyPlus size={21} />
        </span>
        <div>
          <h3>留住这次的舞台</h3>
          <p>把布置保存下来，下次一键继续。</p>
        </div>
      </div>
      <form
        className="stage-template-save"
        onSubmit={(event) => {
          event.preventDefault()
          if (s.save(name)) setName('')
        }}
      >
        <label htmlFor="stage-template-name">模板名称</label>
        <div className="stage-template-name-row">
          <input
            id="stage-template-name"
            maxLength={60}
            placeholder="例如：竖屏直播 · 今日目标"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            className="button primary"
            type="submit"
            disabled={!name.trim() || s.templates.length >= maxStageTemplates}
          >
            <Save size={15} />
            保存
          </button>
        </div>
        <p>
          当前：{aspect === 'auto' ? '自适应' : aspect} · {widgets.length} 个组件 ·{' '}
          {counters.length} 个计数
        </p>
        <p>
          包含比例、按钮显示、背景、特效、叠加、角色缩放及组件布局。自动计数从保存时的数值继续。
        </p>
      </form>
      <div className="stage-template-list-heading">
        <span>
          我的模板{' '}
          <small>
            {s.templates.length}/{maxStageTemplates}
          </small>
        </span>
        {s.previous && (
          <button onClick={s.undoApply}>
            <Undo2 size={13} />
            撤销应用
          </button>
        )}
      </div>
      <p className="stage-template-hint">
        应用会替换当前舞台及组件，可撤销最近一次应用。模板和引用素材保存在本机。
      </p>
      {!s.templates.length && (
        <div className="stage-template-empty">还没有模板，给当前舞台取个名字吧。</div>
      )}
      <div className="stage-template-list">
        {s.templates.map((template) => {
          const { appearance, widgets: savedWidgets, counters: savedCounters } = template.snapshot
          const ratio =
            stageAspectPresets.find((preset) => preset.id === appearance.aspect)?.ratio || 16 / 10
          return (
            <article
              key={template.id}
              className="stage-template-card"
              aria-label={`舞台模板 ${template.name}`}
            >
              <div className="stage-template-card-heading">
                <span
                  className={`stage-template-swatch stage-${appearance.stage}`}
                  aria-hidden="true"
                >
                  <i style={{ aspectRatio: ratio }} />
                </span>
                <div>
                  {renaming === template.id ? (
                    <form
                      className="stage-template-rename"
                      onSubmit={(event) => {
                        event.preventDefault()
                        if (s.rename(template.id, renameValue)) setRenaming(null)
                      }}
                    >
                      <input
                        aria-label="新的模板名称"
                        autoFocus
                        maxLength={60}
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') setRenaming(null)
                        }}
                      />
                      <button type="submit" aria-label="确认重命名" disabled={!renameValue.trim()}>
                        <Check size={14} />
                      </button>
                      <button
                        type="button"
                        aria-label="取消重命名"
                        onClick={() => setRenaming(null)}
                      >
                        <X size={14} />
                      </button>
                    </form>
                  ) : (
                    <h4 title={template.name}>{template.name}</h4>
                  )}
                  <p>
                    {appearance.aspect === 'auto' ? '自适应' : appearance.aspect} ·{' '}
                    {savedWidgets.length} 个组件 · {savedCounters.length} 个计数
                  </p>
                  <time dateTime={new Date(template.savedAt).toISOString()}>
                    {dateFormat.format(template.savedAt)}
                  </time>
                </div>
              </div>
              {updating === template.id ? (
                <div className="stage-template-update" role="group" aria-label="更新模板确认">
                  <span>用当前舞台替换此模板？</span>
                  <button
                    onClick={() => {
                      if (s.save(template.name, template.id)) setUpdating(null)
                    }}
                  >
                    确认更新
                  </button>
                  <button onClick={() => setUpdating(null)}>取消</button>
                </div>
              ) : (
                <div className="stage-template-card-actions">
                  <button className="stage-template-apply" onClick={() => s.apply(template.id)}>
                    <Play size={13} />
                    应用模板
                  </button>
                  <button
                    aria-label={`更新模板 ${template.name}`}
                    title="用当前舞台更新"
                    onClick={() => setUpdating(template.id)}
                  >
                    <Save size={14} />
                  </button>
                  <button
                    aria-label={`重命名模板 ${template.name}`}
                    title="重命名"
                    onClick={() => {
                      setRenaming(template.id)
                      setRenameValue(template.name)
                    }}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    aria-label={`删除模板 ${template.name}`}
                    title="删除模板"
                    onClick={() => s.remove(template.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </article>
          )
        })}
      </div>
      {s.deleted && (
        <button
          className="stage-template-undo-delete"
          disabled={s.templates.length >= maxStageTemplates}
          onClick={s.restoreDeleted}
        >
          <Undo2 size={14} />
          撤销删除「{s.deleted.name}」
        </button>
      )}
    </div>
  )
}
