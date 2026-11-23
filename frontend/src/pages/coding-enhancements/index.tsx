import { useEffect, useState } from 'react'
import { ArrowLeft, Pencil, Plus, Save, Sparkles, Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  codingAPI,
  type CodingEnhancements,
  type CodingMemory,
  type CodingProject,
} from '../../api/coding'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select'
import { Textarea } from '../../components/ui/textarea'
import '../../assets/coding.css'

const options = [
  { field: 'titles', label: '自动会话标题', detail: '根据首条消息生成会话名称。' },
  {
    field: 'model_titles',
    label: '由模型润色标题',
    detail: '首轮完成后，将首条消息及回复的片段发送给当前模型。',
  },
  {
    field: 'rewrite',
    label: '提示词增强',
    detail: '点击输入框旁的增强按钮，使用当前模型改写草稿。',
  },
  {
    field: 'suggestions',
    label: '后续消息建议',
    detail: '每轮完成后，用近期会话生成一条建议，按 Tab 采用。',
  },
  {
    field: 'recall',
    label: '允许 Pi 查询编码记忆',
    detail: '允许当前会话的模型按需读取个人和本项目的记忆。',
  },
  {
    field: 'memory_write',
    label: '允许 Pi 保存项目记忆',
    detail: '在编码模式下，可以按用户请求保存本项目的记忆。',
  },
] as const

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : '操作失败'
}

export default function CodingEnhancementsPage() {
  const [settings, setSettings] = useState<CodingEnhancements>()
  const [saved, setSaved] = useState<CodingEnhancements>()
  const [projects, setProjects] = useState<CodingProject[]>([])
  const [project, setProject] = useState('')
  const [memories, setMemories] = useState<CodingMemory[]>([])
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memory, setMemory] = useState<CodingMemory>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const changed = JSON.stringify(settings) !== JSON.stringify(saved)

  useEffect(() => {
    const controller = new AbortController()
    const failed = (cause: unknown) => {
      if (!controller.signal.aborted) setError(message(cause))
    }
    codingAPI
      .enhancements(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setSettings(value)
          setSaved(value)
        }
      })
      .catch(failed)
    codingAPI
      .projects(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setProjects(items)
      })
      .catch(failed)
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!settings) return
    const controller = new AbortController()
    setMemoryLoading(true)
    codingAPI
      .memories(project, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setMemories(items)
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(message(cause))
      })
      .finally(() => {
        if (!controller.signal.aborted) setMemoryLoading(false)
      })
    return () => controller.abort()
  }, [project, !!settings])

  const perform = async (work: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    setStatus('')
    try {
      await work()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="coding-enhancements">
      <header>
        <Link to="/coding" className="coding-button">
          <ArrowLeft size={15} />
          返回编码模式
        </Link>
        <Link to="/coding/plugins" className="coding-button">
          插件中心
        </Link>
      </header>
      <h1>
        <Sparkles size={20} />
        官方增强设置
      </h1>
      {error && (
        <div className="coding-alert" role="alert">
          {error}
        </div>
      )}
      {status && (
        <p className="coding-muted" role="status">
          {status}
        </p>
      )}
      {settings && (
        <>
          <section className="coding-enhancements-card" aria-label="对话增强">
            {options.map(({ field, label, detail }) => {
              const disabled =
                busy ||
                (field === 'model_titles' && !settings.titles) ||
                (field === 'memory_write' && !settings.recall)
              return (
                <label key={field}>
                  <input
                    type="checkbox"
                    checked={settings[field]}
                    disabled={disabled}
                    onChange={(event) =>
                      setSettings({ ...settings, [field]: event.target.checked })
                    }
                  />
                  <span>
                    <strong>{label}</strong>
                    <small>{detail}</small>
                  </span>
                </label>
              )
            })}
            <button
              className="coding-button coding-primary"
              disabled={busy || !changed}
              onClick={() => {
                void perform(async () => {
                  const value = await codingAPI.saveEnhancements(settings)
                  setSaved(value)
                  setSettings(value)
                  setStatus('增强设置已保存')
                })
              }}
            >
              <Save size={15} />
              保存设置
            </button>
          </section>
          <section className="coding-enhancements-card" aria-label="编码记忆">
            <div className="coding-panel-bar">
              <h2>编码记忆</h2>
              <div className="coding-actions">
                <Select
                  value={project || '__personal__'}
                  disabled={busy}
                  onValueChange={(value) => {
                    setMemories([])
                    setMemory(undefined)
                    setProject(value === '__personal__' ? '' : value)
                  }}
                >
                  <SelectTrigger aria-label="记忆范围">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__personal__">个人记忆</SelectItem>
                    {projects.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <button
                  className="coding-icon"
                  type="button"
                  aria-label="添加编码记忆"
                  disabled={busy}
                  onClick={() => setMemory({ id: '', project_id: project, content: '' })}
                >
                  <Plus size={18} />
                </button>
              </div>
            </div>
            {memory && (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!memory.content.trim()) return
                  void perform(async () => {
                    const item = await codingAPI.saveMemory(
                      memory.content,
                      memory.project_id,
                      memory.id || undefined,
                    )
                    setMemories((items) => [item, ...items.filter((other) => other.id !== item.id)])
                    setMemory(undefined)
                  })
                }}
              >
                <Textarea
                  aria-label="记忆内容"
                  maxLength={2000}
                  rows={3}
                  value={memory.content}
                  onChange={(event) => setMemory({ ...memory, content: event.target.value })}
                />
                <div className="coding-actions">
                  <button
                    className="coding-button"
                    type="button"
                    disabled={busy}
                    onClick={() => setMemory(undefined)}
                  >
                    取消
                  </button>
                  <button
                    className="coding-button coding-primary"
                    disabled={busy || !memory.content.trim()}
                  >
                    保存记忆
                  </button>
                </div>
              </form>
            )}
            {memoryLoading && (
              <p className="coding-muted" role="status">
                正在读取记忆…
              </p>
            )}
            {!memoryLoading && memories.length === 0 && (
              <p className="coding-muted">此范围暂无记忆</p>
            )}
            <ul className="coding-memory-list">
              {memories.map((item) => (
                <li key={item.id}>
                  <p>{item.content}</p>
                  <button
                    className="coding-icon"
                    type="button"
                    aria-label="编辑记忆"
                    disabled={busy}
                    onClick={() => setMemory(item)}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    className="coding-icon"
                    type="button"
                    aria-label="删除记忆"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm('删除该条编码记忆？')) return
                      void perform(async () => {
                        await codingAPI.removeMemory(item.id)
                        setMemories((items) => items.filter((other) => other.id !== item.id))
                        if (memory?.id === item.id) setMemory(undefined)
                      })
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
