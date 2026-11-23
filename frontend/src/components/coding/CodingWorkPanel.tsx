/**
 * CodingWorkPanel 是编码工作台的右侧面板：在文件浏览/编辑、Git 变更、浏览器预览、
 * 终端和插件视图之间切换，并负责文件保存、外部变更检测与引用到会话。
 */
import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  Copy,
  Eye,
  FileCode2,
  Folder,
  Radio,
  RefreshCw,
  Save,
  Search,
  Settings2,
  X,
} from 'lucide-react'
import { codingAPI } from '../../api/coding'
import type { CodingChanges, CodingFile, CodingProject, FileEntry } from '../../api/coding'
import CodingFileSearch from './CodingFileSearch'
import CodingBrowserPanel from './CodingBrowserPanel'
import { CodingMediaPreview, CodingTextPreview, mediaPreviewKind } from './CodingFilePreview'
import CodingSQLitePreview from './CodingSQLitePreview'
import CodingTerminalPanel from './CodingTerminalPanel'
import { CodingPluginDock } from './CodingPluginRuntime'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { Textarea } from '../ui/textarea'
import type { PiHostPlugin } from '../../api/piplugins'

/** Props 工作面板的入参。 */
interface Props {
  /** 当前编码项目。 */
  project: CodingProject
  /** 会话写入文件后推送的更新标记，用于触发文件重新加载。 */
  update?: { path: string }
  /** 是否启用文件管理插件能力。 */
  filePlugin: boolean
  /** 是否启用浏览器插件能力。 */
  browserPlugin: boolean
  /** 初始视图；来自 URL 的 panel 参数。 */
  initialTab?: 'browser' | 'files' | 'terminal'
  /** 可用的运行时插件，用于「插件视图」标签。 */
  runtimePlugins: PiHostPlugin[]
  /** 当前会话 ID，传给插件作为上下文。 */
  sessionID?: string
  /** 把文件引用插入会话输入框。 */
  onQuote: (reference: string) => void
}

/** CodingWorkPanel 编码工作台右侧多视图工作面板。 */
export default function CodingWorkPanel({
  project,
  update,
  filePlugin,
  browserPlugin,
  initialTab = 'files',
  runtimePlugins,
  sessionID,
  onQuote,
}: Props) {
  const [tab, setTab] = useState<'files' | 'changes' | 'browser' | 'terminal' | 'plugins'>(
    initialTab,
  )
  // 终端一旦挂载就保持存在（仅 hidden 切换），避免切标签时丢失终端会话。
  const [terminalMounted, setTerminalMounted] = useState(initialTab === 'terminal')
  const [fileActionsOpen, setFileActionsOpen] = useState(false)
  const [entryAction, setEntryAction] = useState<'file' | 'directory' | 'move' | 'remove'>('file')
  const [entryPath, setEntryPath] = useState('')
  const [entryTarget, setEntryTarget] = useState('')
  const [directory, setDirectory] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [selection, setSelection] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [preview, setPreview] = useState(false)
  const [file, setFile] = useState<CodingFile>()
  const [draft, setDraft] = useState('')
  const [changes, setChanges] = useState<CodingChanges>()
  const [reload, setReload] = useState(0)
  const [fileReload, setFileReload] = useState(0)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [watch, setWatch] = useState(true)
  const [externalChange, setExternalChange] = useState(false)
  const editor = useRef<HTMLTextAreaElement>(null)
  const dirty = !!file && draft !== file.content
  const markdown = /\.(md|markdown)$/i.test(selection)
  const textPreview = markdown || (filePlugin && /\.(json|csv|tsv)$/i.test(selection))
  const sqlite = filePlugin && /\.(db|db3|sqlite|sqlite3)$/i.test(selection)
  const media = filePlugin && (!!mediaPreviewKind(selection) || sqlite)
  const seenUpdate = useRef(update)

  useEffect(() => {
    if (seenUpdate.current === update) return
    seenUpdate.current = update
    // 会话改动文件后自动重载当前文件，但用户有未保存修改时不覆盖草稿。
    if (update?.path === selection && !dirty && !saving) setFileReload((value) => value + 1)
  }, [update, selection, dirty, saving])

  useEffect(() => {
    if (tab !== 'files' && tab !== 'changes') return
    // 隐藏标签不请求数据；切回时依赖状态变化重新触发。
    const request = new AbortController()
    const failed = (error: Error) => {
      if (!request.signal.aborted) setError(error.message)
    }
    setError('')
    setLoading(true)
    async function load() {
      try {
        if (tab === 'files') {
          const items = await codingAPI.files(project.id, directory, request.signal)
          if (!request.signal.aborted) setEntries(items)
        } else {
          const next = await codingAPI.changes(project.id, request.signal)
          if (!request.signal.aborted) setChanges(next)
        }
      } catch (cause) {
        failed(cause instanceof Error ? cause : new Error('读取工作面板失败'))
      } finally {
        if (!request.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => request.abort()
  }, [project.id, tab, directory, update, reload])

  useEffect(() => {
    if (!selection) return
    // 媒体/数据库预览不需要文本内容，跳过文本读取以免把二进制当文本解析。
    if (media) {
      setFile(undefined)
      return
    }
    const request = new AbortController()
    setFile(undefined)
    codingAPI
      .file(project.id, selection, request.signal)
      .then((next) => {
        if (request.signal.aborted) return
        setFile(next)
        setDraft(next.content)
      })
      .catch((cause: Error) => {
        if (request.signal.aborted) return
        setError(cause.message)
        setSelection('')
      })
    return () => request.abort()
  }, [project.id, selection, fileReload, media])

  useEffect(() => {
    if (!filePlugin || !watch || tab !== 'files' || saving || loading || media) return
    const controller = new AbortController()
    let refreshing = false
    // 后端没有文件系统推送通道，用 3 秒轮询对比 revision 检测外部改动。
    const timer = window.setInterval(async () => {
      // 页面不可见或上一轮未结束时跳过，减少无意义请求。
      if (document.hidden || refreshing) return
      refreshing = true
      try {
        if (!selection) {
          const listed = await codingAPI.files(project.id, directory, controller.signal)
          if (!controller.signal.aborted) {
            setEntries((old) => (JSON.stringify(old) === JSON.stringify(listed) ? old : listed))
          }
        } else if (file) {
          const next = await codingAPI.file(project.id, selection, controller.signal)
          if (!controller.signal.aborted && next.revision !== file.revision) {
            // 有未保存修改时不直接覆盖，只提示磁盘已变更，由用户决定是否重载。
            if (dirty) setExternalChange(true)
            else setFileReload((value) => value + 1)
          }
        }
      } catch {
        if (!controller.signal.aborted && selection) setExternalChange(true)
      } finally {
        refreshing = false
      }
    }, 3000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [
    filePlugin,
    watch,
    tab,
    project.id,
    directory,
    selection,
    file,
    media,
    dirty,
    saving,
    loading,
  ])

  const save = async () => {
    if (!file || !dirty || saving) return
    setSaving(true)
    setError('')
    try {
      // 提交读取时的 revision 做乐观并发控制，磁盘被外部改动时由后端拒绝覆盖。
      const saved = await codingAPI.saveFile(project.id, selection, {
        content: draft,
        revision: file.revision,
      })
      setFile(saved)
      setDraft(saved.content)
      setExternalChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存文件失败')
    } finally {
      setSaving(false)
    }
  }

  const closeFile = () => {
    // 未保存修改需二次确认，避免误触关闭丢失编辑。
    if (dirty && !window.confirm('放弃此文件未保存的修改？')) return
    setSelection('')
    setPreview(false)
    setExternalChange(false)
    setFile(undefined)
    setError('')
  }

  const openFile = (path: string) => {
    // 切换到另一个文件前确认放弃当前草稿。
    if (saving || (selection !== path && dirty && !window.confirm('放弃此文件未保存的修改？')))
      return
    setTab('files')
    setSearchOpen(false)
    setPreview(false)
    setExternalChange(false)
    setError('')
    setSelection(path)
    setDirectory(path.split('/').slice(0, -1).join('/'))
  }

  const runFileAction = async () => {
    if (!entryPath.trim() || saving || (entryAction === 'move' && !entryTarget.trim())) return
    const path = entryPath.trim()
    const target = entryTarget.trim()
    if (entryAction === 'remove' && !window.confirm(`删除项目条目 ${path}？`)) return
    // 删除/移动的路径包含正在编辑且未保存的文件时直接拒绝，避免编辑器指向已消失的文件。
    if (
      (entryAction === 'remove' || entryAction === 'move') &&
      dirty &&
      (selection === path || selection.startsWith(`${path}/`))
    ) {
      setError('请先保存或关闭正在编辑的文件')
      return
    }
    setSaving(true)
    setError('')
    try {
      await codingAPI.fileAction(project.id, entryAction, path, target)
      if (selection === path || selection.startsWith(`${path}/`)) closeFile()
      if (directory === path || directory.startsWith(`${path}/`)) {
        if (entryAction === 'remove' || entryAction === 'move') setDirectory('')
      }
      setReload((value) => value + 1)
      setFileActionsOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '文件操作失败')
    } finally {
      setSaving(false)
    }
  }

  const quote = () => {
    const input = editor.current
    // 草稿未修改、非预览态且有选区时引用「路径:行号范围」，否则只引用文件路径。
    if (!dirty && !preview && input && input.selectionEnd > input.selectionStart) {
      const start = draft.slice(0, input.selectionStart).split('\n').length
      const end = draft.slice(0, input.selectionEnd - 1).split('\n').length
      onQuote(`${selection}:L${start}${end > start ? `–L${end}` : ''}`)
    } else {
      onQuote(selection)
    }
  }

  return (
    <aside className="coding-workpanel" aria-label="项目工作面板">
      <header className="coding-panel-bar">
        <div className="coding-workpanel-switch" aria-label="项目视图">
          <button aria-pressed={tab === 'files'} onClick={() => setTab('files')}>
            文件
          </button>
          <button aria-pressed={tab === 'changes'} onClick={() => setTab('changes')}>
            Git 变更
          </button>
          {browserPlugin && (
            <button
              aria-pressed={tab === 'browser'}
              onClick={() => {
                setTab('browser')
                setSearchOpen(false)
              }}
            >
              浏览器
            </button>
          )}
          <button
            aria-pressed={tab === 'terminal'}
            onClick={() => {
              setTerminalMounted(true)
              setTab('terminal')
              setSearchOpen(false)
            }}
          >
            终端
          </button>
          {runtimePlugins.some((plugin) => plugin.views?.some((view) => view.kind === 'view')) && (
            <button
              aria-pressed={tab === 'plugins'}
              onClick={() => {
                setTab('plugins')
                setSearchOpen(false)
              }}
            >
              插件视图
            </button>
          )}
        </div>
        {(tab === 'files' || tab === 'changes') && (
          <div className="coding-actions">
            {filePlugin && (
              <button
                type="button"
                className="coding-icon"
                aria-label="文件操作"
                title="文件操作"
                aria-expanded={fileActionsOpen}
                disabled={saving}
                onClick={() => {
                  setTab('files')
                  setEntryPath(selection || (directory && `${directory}/`))
                  setEntryTarget('')
                  setFileActionsOpen(!fileActionsOpen)
                }}
              >
                <Settings2 size={15} />
              </button>
            )}
            <button
              className="coding-icon"
              type="button"
              aria-label="查找项目文件"
              title="查找项目文件"
              aria-expanded={searchOpen}
              disabled={saving}
              onClick={() => setSearchOpen(!searchOpen)}
            >
              <Search size={15} />
            </button>
            <button
              className="coding-icon"
              type="button"
              aria-label="刷新项目视图"
              disabled={loading || saving}
              onClick={() => {
                setReload((value) => value + 1)
                if (tab === 'files' && selection && !dirty) setFileReload((value) => value + 1)
              }}
            >
              <RefreshCw size={15} />
            </button>
            {filePlugin && tab === 'files' && (
              <button
                type="button"
                className="coding-icon"
                aria-label="自动刷新文件"
                title="自动刷新文件"
                aria-pressed={watch}
                onClick={() => setWatch(!watch)}
              >
                <Radio size={15} />
              </button>
            )}
          </div>
        )}
      </header>
      {tab === 'browser' && browserPlugin && <CodingBrowserPanel />}
      {tab === 'plugins' && (
        <CodingPluginDock
          plugins={runtimePlugins}
          workspace={{ project_id: project.id, session_id: sessionID }}
        />
      )}
      {terminalMounted && (
        <div className="coding-terminal-host" hidden={tab !== 'terminal'}>
          <CodingTerminalPanel project={project} visible={tab === 'terminal'} />
        </div>
      )}
      {tab === 'files' && filePlugin && fileActionsOpen && (
        <form
          className="coding-file-actions-form"
          onSubmit={(event) => {
            event.preventDefault()
            void runFileAction()
          }}
        >
          <Select
            value={entryAction}
            onValueChange={(action) => setEntryAction(action as typeof entryAction)}
          >
            <SelectTrigger aria-label="条目操作">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="file">新建文件</SelectItem>
              <SelectItem value="directory">新建目录</SelectItem>
              <SelectItem value="move">重命名或移动</SelectItem>
              <SelectItem value="remove">删除文件或空目录</SelectItem>
            </SelectContent>
          </Select>
          <input
            aria-label="项目相对路径"
            placeholder="项目相对路径"
            value={entryPath}
            onChange={(event) => setEntryPath(event.target.value)}
          />
          {entryAction === 'move' && (
            <input
              aria-label="目标相对路径"
              placeholder="目标相对路径"
              value={entryTarget}
              onChange={(event) => setEntryTarget(event.target.value)}
            />
          )}
          <button
            className="coding-button"
            disabled={
              saving || !entryPath.trim() || (entryAction === 'move' && !entryTarget.trim())
            }
          >
            执行
          </button>
        </form>
      )}
      {searchOpen && (
        <CodingFileSearch
          project={project.id}
          onChoose={openFile}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {error && (
        <p className="coding-alert" role="alert">
          {error}
        </p>
      )}
      {tab === 'files' && !selection && (
        <>
          <div className="coding-file-path">
            <button
              className="coding-icon"
              type="button"
              disabled={!directory || loading}
              aria-label="返回上一级"
              onClick={() => setDirectory(directory.split('/').slice(0, -1).join('/'))}
            >
              <ArrowUp size={15} />
            </button>
            <span title={directory || project.path}>{directory || project.name}</span>
          </div>
          <div className="coding-file-list">
            {!loading && entries.length === 0 && (
              <p className="coding-muted">此目录暂无可浏览文件</p>
            )}
            {entries.map((entry) => (
              <button
                disabled={loading}
                key={entry.name}
                title={entry.name}
                onClick={() => {
                  const path = directory ? `${directory}/${entry.name}` : entry.name
                  setError('')
                  if (entry.dir) setDirectory(path)
                  else openFile(path)
                }}
              >
                {entry.dir ? <Folder size={15} /> : <FileCode2 size={15} />}
                <span>{entry.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {tab === 'files' && selection && (
        <div className="coding-editor">
          <div className="coding-file-path">
            <button
              type="button"
              className="coding-icon"
              aria-label="关闭文件"
              disabled={saving}
              onClick={closeFile}
            >
              <X size={15} />
            </button>
            <span title={selection}>{selection}</span>
            {filePlugin && (
              <button
                type="button"
                className="coding-icon"
                aria-label="引用到会话"
                title="引用到会话"
                onMouseDown={(event) => event.preventDefault()}
                onClick={quote}
              >
                @
              </button>
            )}
            {filePlugin && (
              <button
                className="coding-icon"
                type="button"
                aria-label="复制相对路径"
                title="复制相对路径"
                onClick={() => {
                  navigator.clipboard
                    .writeText(selection)
                    .catch(() => setError('复制失败，请手动选择文件路径'))
                }}
              >
                <Copy size={14} />
              </button>
            )}
            {textPreview && (
              <button
                type="button"
                className="coding-icon"
                aria-label={markdown ? '预览 Markdown' : '预览结构化数据'}
                title="预览文件"
                aria-pressed={preview}
                disabled={!file}
                onClick={() => setPreview(!preview)}
              >
                <Eye size={15} />
              </button>
            )}
            {!media && (
              <button
                type="button"
                className="coding-icon"
                aria-label="保存文件"
                disabled={!dirty || saving}
                onClick={() => void save()}
              >
                <Save size={15} />
              </button>
            )}
          </div>
          {externalChange && (
            <div className="coding-file-path">
              <span>磁盘上的文件有变动</span>
              <button
                type="button"
                className="coding-button"
                disabled={saving}
                onClick={() => {
                  if (!dirty || window.confirm('重新加载文件并丢弃未保存的修改？')) {
                    setExternalChange(false)
                    setFileReload((value) => value + 1)
                  }
                }}
              >
                重新加载
              </button>
            </div>
          )}
          {sqlite ? (
            <CodingSQLitePreview
              key={`${selection}-${fileReload}`}
              project={project.id}
              path={selection}
            />
          ) : media ? (
            <div className="coding-media-preview">
              <CodingMediaPreview
                key={`${selection}-${fileReload}`}
                project={project.id}
                path={selection}
              />
            </div>
          ) : file && preview && textPreview ? (
            <CodingTextPreview path={selection} text={draft} />
          ) : file ? (
            <Textarea
              ref={editor}
              aria-label={`编辑 ${selection}`}
              value={draft}
              disabled={saving}
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // Ctrl/Cmd+S 保存并阻止浏览器默认的「保存网页」。
                if ((event.ctrlKey || event.metaKey) && event.key === 's') {
                  event.preventDefault()
                  void save()
                }
              }}
            />
          ) : (
            <p className="coding-muted" role="status">
              正在读取文件…
            </p>
          )}
          {dirty && <p className="coding-muted">文件有未保存的修改</p>}
        </div>
      )}
      {tab === 'changes' && (
        <div className="coding-changes">
          {!changes && (
            <p className="coding-muted" role="status">
              {loading ? '正在读取 Git 变更…' : '暂无 Git 变更'}
            </p>
          )}
          {changes && !changes.available && (
            <p className="coding-muted">此目录没有可读取的 Git 工作树。</p>
          )}
          {changes?.available && !changes.status && <p className="coding-muted">工作树干净</p>}
          {changes?.status && <pre className="coding-git-status">{changes.status}</pre>}
          {changes?.diff && (
            <pre aria-label="项目差异">
              {changes.diff.split('\n').map((line, index) => (
                <span
                  key={index}
                  className={
                    line.startsWith('+')
                      ? 'coding-diff-add'
                      : line.startsWith('-')
                        ? 'coding-diff-remove'
                        : undefined
                  }
                >
                  {line}
                  {'\n'}
                </span>
              ))}
            </pre>
          )}
        </div>
      )}
    </aside>
  )
}
