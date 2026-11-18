/** 当前角色的动作、原生表情与情绪预设命名编辑器。 */
import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Pencil, Play, RotateCcw, Save, Search, X } from 'lucide-react'
import { api } from '../api/client'
import { notify, useStudio } from '../store/studio'
import type { ActionNames, Character, CharacterActions } from '../types/api'
import type { Live2DStageHandle } from './Live2DStage'
import Live2DStage from './Live2DStage'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import '../assets/action-names.css'

const categories = [
  { key: 'motions', label: '动作' },
  { key: 'expressions', label: '原生表情' },
  { key: 'moods', label: '情绪预设' },
] as const
const emptyNames = (): ActionNames => ({ motions: {}, expressions: {}, moods: {} })

export default function CharacterActionNames({
  character,
  onClose,
}: {
  character: Character
  onClose: () => void
}) {
  const stageRef = useRef<Live2DStageHandle>(null)
  const [previewReady, setPreviewReady] = useState(false)
  const [previewStatus, setPreviewStatus] = useState('')
  const [catalog, setCatalog] = useState<CharacterActions | null>(null)
  const [draft, setDraft] = useState(emptyNames)
  const [category, setCategory] = useState<keyof ActionNames>('motions')
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void api
      .characterActions(character.id, controller.signal)
      .then(
        (data) => {
          if (controller.signal.aborted) return
          setCatalog(data)
          setDraft({
            motions: { ...data.action_names.motions },
            expressions: { ...data.action_names.expressions },
            moods: { ...data.action_names.moods },
          })
        },
        (cause: Error) => {
          if (!controller.signal.aborted) setError(cause.message)
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [character.id, attempt])

  const close = () => {
    if (!saving) onClose()
  }
  const save = async () => {
    if (!catalog || loading || saving) return
    setSaving(true)
    setError('')
    try {
      const saved = await api.saveActionNames(character.id, catalog.model_path, draft)
      useStudio.setState((state) => ({
        characters: state.characters.map((item) => (item.id === saved.id ? saved : item)),
      }))
      notify('动作与表情名称已保存，智能体下次查询将使用新名称')
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存名称失败')
    } finally {
      setSaving(false)
    }
  }
  const query = search.trim().toLowerCase()
  const items =
    catalog?.[category].filter((item) =>
      [item.default_label, item.id, draft[category]?.[item.id] ?? ''].some((text) =>
        text.toLowerCase().includes(query),
      ),
    ) ?? []
  const preview = async (id: string) => {
    const stage = stageRef.current
    if (!stage) {
      notify('当前舞台尚未就绪')
      return
    }
    try {
      if (category === 'moods') {
        stage.setMood(id)
      } else {
        const ok = await (category === 'motions' ? stage.playMotion(id) : stage.setExpression(id))
        if (!ok) notify('预览失败，请检查模型是否加载完成')
      }
    } catch {
      notify('预览失败，请检查模型资源')
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        className="action-names-dialog"
        showCloseButton={false}
        aria-describedby="action-names-description"
        onPointerDownOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault()
        }}
      >
        <header className="action-names-heading">
          <span className="action-names-icon">
            <Pencil size={19} />
          </span>
          <div>
            <DialogTitle>动作与表情命名</DialogTitle>
            <p>{character.name} 的专属配置</p>
          </div>
          <button
            className="icon-button"
            aria-label="关闭命名配置"
            disabled={saving}
            onClick={close}
          >
            <X size={19} />
          </button>
        </header>
        <p id="action-names-description" className="action-names-description">
          给动作或表情起一个容易记住的名字，舞台列表和智能体都会使用它。留空恢复默认名称，可先预览再命名。
        </p>
        {loading ? (
          <div className="action-names-empty" role="status">
            <LoaderCircle size={18} className="spin" />
            正在读取模型配置…
          </div>
        ) : (
          catalog && (
            <div className="action-names-content">
              <section
                className="action-names-preview"
                aria-label={`${character.name} 的动作与表情预览`}
              >
                <div className="action-names-preview-stage">
                  <Live2DStage
                    ref={stageRef}
                    modelPath={catalog.model_path}
                    actionNames={character.action_names}
                    isolated
                    onCapabilitiesChange={(capabilities) => setPreviewReady(capabilities.ready)}
                    onInteraction={setPreviewStatus}
                  />
                </div>
                <p className="action-names-preview-status" role="status">
                  {previewStatus || '点击右侧预览，确认效果后再命名。'}
                </p>
              </section>
              <div className="action-names-fields">
                <div className="action-names-categories" role="group" aria-label="命名分类">
                  {categories.map(({ key, label }) => (
                    <button
                      key={key}
                      aria-pressed={category === key}
                      onClick={() => {
                        setCategory(key)
                        setSearch('')
                      }}
                    >
                      {label}
                      <span>{catalog[key].length}</span>
                    </button>
                  ))}
                </div>
                <label className="action-names-search">
                  <Search size={15} />
                  <input
                    aria-label="搜索动作或表情"
                    placeholder="搜索名称或原始标识…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                {(catalog.unavailable_motions > 0 || catalog.unavailable_expressions > 0) && (
                  <p className="action-names-description">
                    有 {catalog.unavailable_motions} 个动作、{catalog.unavailable_expressions}{' '}
                    个表情资源缺失，暂时无法预览或重新命名。
                  </p>
                )}
                <div className="action-names-list">
                  {items.map((item) => (
                    <div className="action-name-row" key={item.id}>
                      <div className="action-name-original">
                        <span title={item.default_label}>{item.default_label}</span>
                        <button
                          type="button"
                          disabled={saving || !previewReady}
                          onClick={() => void preview(item.id)}
                          aria-label={`预览 ${item.default_label}`}
                        >
                          <Play size={12} />
                          预览
                        </button>
                      </div>
                      <input
                        aria-label={`${item.default_label} 的自定义名称`}
                        maxLength={60}
                        disabled={saving}
                        placeholder={item.default_label}
                        value={draft[category]?.[item.id] ?? ''}
                        onChange={(event) => {
                          const value = event.target.value
                          setDraft((names) => ({
                            ...names,
                            [category]: { ...names[category], [item.id]: value },
                          }))
                        }}
                      />
                    </div>
                  ))}
                  {!items.length && (
                    <p className="action-names-empty">
                      {query ? '没有匹配的动作或表情' : '当前模型没有可用的此类资源'}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )
        )}
        {error && (
          <div className="action-names-error" role="alert">
            {error}
            {!catalog && !loading && (
              <button onClick={() => setAttempt((value) => value + 1)}>重新读取</button>
            )}
          </div>
        )}
        <footer className="action-names-footer">
          <button
            className="button ghost"
            disabled={loading || saving || !catalog}
            onClick={() => setDraft(emptyNames())}
          >
            <RotateCcw size={14} />
            恢复默认命名
          </button>
          <button
            className="button primary"
            disabled={loading || saving || !catalog}
            onClick={() => void save()}
          >
            {saving ? <LoaderCircle size={14} /> : <Save size={14} />}
            {saving ? '正在保存…' : '保存名称'}
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
