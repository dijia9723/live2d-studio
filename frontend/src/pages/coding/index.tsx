/**
 * CodingPage 是编码工作台主页面：左侧管理项目与会话，中间渲染对话与输入框，
 * 右侧加载 CodingWorkPanel，并负责 SSE 流式对话、提示词增强与插件运行时联动。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  Archive,
  ArrowUp,
  AtSign,
  Braces,
  Boxes,
  FolderOpen,
  GitBranch,
  MessageSquare,
  Pencil,
  Puzzle,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Square,
  X,
} from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import { api } from '../../api/client'
import { codingAPI, streamCoding } from '../../api/coding'
import type {
  CodingMessage,
  CodingEnhancements,
  CodingMode,
  CodingProject,
  CodingSession,
  CodingToolRun,
} from '../../api/coding'
import CodingWorkPanel from '../../components/coding/CodingWorkPanel'
import CodingFileSearch from '../../components/coding/CodingFileSearch'
import CodingBrowserPanel from '../../components/coding/CodingBrowserPanel'
import CodingPluginRuntime from '../../components/coding/CodingPluginRuntime'
import CodingOrchestration from '../../components/coding/CodingOrchestration'
import CodingSessionModel from '../../components/coding/CodingSessionModel'
import {
  piPluginsAPI,
  type PiHostPlugin,
  type PiPlugin,
  type PiPluginTheme,
} from '../../api/piplugins'
import { notify, useStudio } from '../../store/studio'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select'
import { Textarea } from '../../components/ui/textarea'
import '../../assets/coding.css'

// 工具名称到中文标签的映射，未收录的工具直接显示原始名称。
const toolLabels: Record<string, string> = {
  list_files: '浏览',
  read_file: '读取',
  write_file: '写入',
  plugin_skill: '使用 Skill',
  plugin_mcp: '调用 MCP',
  coding_memory: '编码记忆',
  plugin_action: '运行插件工具',
  delegate_task: '委派子 Agent',
  session_task: '工作会话',
  project_instructions: '读取项目指令',
}

/** ToolLog 展示一条助手消息中执行过的工具调用摘要。 */
function ToolLog({ tools }: { tools?: CodingToolRun[] }) {
  if (!tools?.length) return null
  return (
    <ul className="coding-tool-log">
      {tools.map((tool, index) => (
        <li key={index}>
          {toolLabels[tool.name] || tool.name} {tool.path || '.'}
        </li>
      ))}
    </ul>
  )
}

/** report 将未知异常转换为编码工作台可展示的中文错误。 */
function report(cause: unknown) {
  return cause instanceof Error ? cause.message : '编码工作台操作失败'
}

/** CodingPage 编码工作台页面。 */
export default function CodingPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const panel = searchParams.get('panel')
  const requestedPanel = panel === 'browser' || panel === 'terminal' ? panel : 'files'
  const requestedPlugin = searchParams.get('plugin') ?? undefined
  const model = useStudio((state) => state.settings?.llm.model)
  const [plugins, setPlugins] = useState<PiPlugin[]>([])
  const [runtimePlugins, setRuntimePlugins] = useState<PiHostPlugin[]>([])
  const [pluginDialog, setPluginDialog] = useState(false)
  const [orchestrationBusy, setOrchestrationBusy] = useState(false)
  const [themes, setThemes] = useState<PiPluginTheme[]>([])
  const [themeID, setThemeID] = useState(() => localStorage.getItem('studio-coding-theme') || '')
  const [enhancements, setEnhancements] = useState<CodingEnhancements>()
  const [suggestion, setSuggestion] = useState<{ session: string; text: string }>()
  const [rewriteUndo, setRewriteUndo] = useState<{ before: string; after: string }>()
  const [rewriting, setRewriting] = useState(false)
  const rewriteRequest = useRef<AbortController>(null)
  const suggestionRequest = useRef<AbortController>(null)
  const [projects, setProjects] = useState<CodingProject[]>([])
  const [projectID, setProjectID] = useState(
    () => localStorage.getItem('studio-coding-project') || '',
  )
  const [sessionID, setSessionID] = useState(
    () => localStorage.getItem('studio-coding-session') || '',
  )
  const [sessions, setSessions] = useState<{ project: string; items: CodingSession[] }>()
  const [history, setHistory] = useState<{ session: string; messages: CodingMessage[] }>()
  const [runtime, setRuntime] = useState<{ ready: boolean; message?: string }>()
  const [desktop, setDesktop] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [projectPath, setProjectPath] = useState('')
  const [projectBusy, setProjectBusy] = useState(false)
  const [sessionBusy, setSessionBusy] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [sessionQuery, setSessionQuery] = useState('')
  const [titleDraft, setTitleDraft] = useState<string>()
  const [prompt, setPrompt] = useState('')
  const [referenceOpen, setReferenceOpen] = useState(false)
  const promptInput = useRef<HTMLTextAreaElement>(null)
  const referenceSelection = useRef<[number, number]>([0, 0])
  const [mode, setMode] = useState<CodingMode>('plan')
  const [error, setError] = useState('')
  const [pending, setPending] = useState<{ user: string; answer: string; tools: CodingToolRun[] }>()
  const [stopping, setStopping] = useState(false)
  const [workspaceUpdate, setWorkspaceUpdate] = useState<{ path: string }>()
  const request = useRef<AbortController>(null)
  const working = !!pending
  const project = projects.find((item) => item.id === projectID) ?? projects[0]
  const projectSessions = sessions?.project === project?.id ? (sessions?.items ?? []) : []
  // 归档与会话列表互斥展示，避免活跃列表被历史会话淹没。
  const shownSessions = projectSessions.filter((item) => item.archived === showArchived)
  const session = shownSessions.find((item) => item.id === sessionID) ?? shownSessions[0]
  const matchingSessions = shownSessions.filter((item) =>
    item.title.toLowerCase().includes(sessionQuery.trim().toLowerCase()),
  )
  const messages = history?.session === session?.id ? (history?.messages ?? []) : []
  // 只有会话未归档、历史已加载、运行时就绪且编排空闲时才允许发送。
  const ready =
    !!session &&
    !session.archived &&
    !orchestrationBusy &&
    history?.session === session.id &&
    runtime?.ready
  const filePlugin = plugins.some((item) => item.id === 'pi.file-manager' && item.enabled)
  const browserPlugin = plugins.some((item) => item.id === 'pi.browser' && item.enabled)
  const enhancementEnabled = plugins.some(
    (item) => item.id === 'pi.official-enhancements' && item.enabled,
  )
  const suggestedText = session && suggestion?.session === session.id ? suggestion?.text : undefined
  const theme = themes.find((item) => item.id === themeID)

  const refreshRuntime = () =>
    codingAPI
      .runtime()
      .then(setRuntime)
      .catch((cause) => setError(report(cause)))

  useEffect(() => {
    if (!runtimePlugins.length) return
    const controller = new AbortController()
    let running = false
    // 插件运行时的 toast 只能轮询拉取；1.6 秒一次且页面隐藏时暂停。
    const timer = window.setInterval(async () => {
      if (document.hidden || running) return
      running = true
      try {
        const events = await piPluginsAPI.runtimeEvents(controller.signal)
        for (const event of events ?? []) {
          if (!controller.signal.aborted && event.type === 'toast' && event.text) {
            const name = runtimePlugins.find((plugin) => plugin.id === event.plugin_id)?.name
            if (name) notify(`${name} · ${event.text.slice(0, 240)}`)
          }
        }
      } catch {
        // 插件运行时可能在通知请求进行中被停止，这里的失败可忽略。
      } finally {
        running = false
      }
    }, 1600)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [runtimePlugins])

  useEffect(() => {
    const controller = new AbortController()
    const failed = (cause: unknown) => {
      if (!controller.signal.aborted) setError(report(cause))
    }
    codingAPI.projects(controller.signal).then(setProjects).catch(failed)
    codingAPI.runtime(controller.signal).then(setRuntime).catch(failed)
    piPluginsAPI
      .runtime(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setRuntimePlugins(items ?? [])
      })
      .catch(failed)
    piPluginsAPI
      .themes(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setThemes(items)
      })
      .catch(failed)
    piPluginsAPI
      .list(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return
        setPlugins(items)
        // 仅在官方增强插件启用时才加载增强配置，避免无谓请求。
        if (items.some((item) => item.id === 'pi.official-enhancements' && item.enabled)) {
          codingAPI
            .enhancements(controller.signal)
            .then((value) => {
              if (!controller.signal.aborted) setEnhancements(value)
            })
            .catch(failed)
        }
      })
      .catch(failed)
    api
      .desktop()
      .then((value) => {
        if (!controller.signal.aborted) setDesktop(value.available)
      })
      .catch(failed)
    return () => {
      // 页面卸载时中止所有在途请求，包括流式对话、改写与建议。
      controller.abort()
      request.current?.abort()
      rewriteRequest.current?.abort()
      suggestionRequest.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!project) return
    const controller = new AbortController()
    localStorage.setItem('studio-coding-project', project.id)
    codingAPI
      .sessions(project.id, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setSessions({ project: project.id, items })
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(report(cause))
      })
    return () => controller.abort()
  }, [project?.id])

  useEffect(() => {
    if (!session) return
    const controller = new AbortController()
    localStorage.setItem('studio-coding-session', session.id)
    codingAPI
      .messages(session.id, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setHistory({ session: session.id, messages: items })
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(report(cause))
      })
    return () => controller.abort()
  }, [session?.id])

  const selectSession = (id: string) => {
    // 切换会话前中止上一个会话的改写/建议请求并清空临时状态，防止结果串到新会话。
    rewriteRequest.current?.abort()
    suggestionRequest.current?.abort()
    setRewriting(false)
    setSuggestion(undefined)
    setRewriteUndo(undefined)
    setOrchestrationBusy(false)
    setSessionID(id)
    setTitleDraft(undefined)
    setReferenceOpen(false)
    setError('')
  }

  const rewritePrompt = async () => {
    if (!prompt.trim() || rewriting || working) return
    const before = prompt
    const controller = new AbortController()
    rewriteRequest.current = controller
    setError('')
    setRewriting(true)
    try {
      const after = await codingAPI.rewrite(before, controller.signal)
      if (!controller.signal.aborted) {
        // 仅当用户在此期间没有继续修改草稿时才替换，避免覆盖新输入。
        setPrompt((current) => (current === before ? after : current))
        setRewriteUndo({ before, after })
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(report(cause))
    } finally {
      if (rewriteRequest.current === controller && !controller.signal.aborted) {
        rewriteRequest.current = null
        setRewriting(false)
      }
    }
  }

  const selectProject = (id: string) => {
    setProjectID(id)
    setShowArchived(false)
    setSessionQuery('')
    selectSession('')
  }

  const addProject = async (pick = false) => {
    if (projectBusy || working || (!pick && !projectPath.trim())) return
    setProjectBusy(true)
    setError('')
    try {
      const path = pick ? await codingAPI.pickDirectory() : projectPath.trim()
      if (!path) return
      const added = await codingAPI.addProject(path)
      setProjects((items) =>
        items.some((item) => item.id === added.id) ? items : [...items, added],
      )
      if (added.id !== project?.id) selectProject(added.id)
      setAddOpen(false)
      setProjectPath('')
    } catch (cause) {
      setError(report(cause))
    } finally {
      setProjectBusy(false)
    }
  }

  const newSession = async () => {
    if (!project || sessions?.project !== project.id || sessionBusy || working) return
    setSessionBusy(true)
    setError('')
    try {
      const created = await codingAPI.newSession(project.id)
      setSessions((current) => ({
        project: project.id,
        items: [created, ...(current?.items ?? [])],
      }))
      setShowArchived(false)
      setSessionQuery('')
      selectSession(created.id)
    } catch (cause) {
      setError(report(cause))
    } finally {
      setSessionBusy(false)
    }
  }

  const manageSession = async (action: 'fork' | 'rename' | 'archive') => {
    if (!project || !session || working || sessionBusy) return
    setSessionBusy(true)
    setError('')
    try {
      const changed =
        action === 'fork'
          ? await codingAPI.forkSession(session.id)
          : await codingAPI.updateSession(
              session.id,
              action === 'archive'
                ? { archived: !session.archived }
                : { title: titleDraft?.trim() },
            )
      setSessions((current) =>
        current?.project === project.id
          ? {
              project: project.id,
              items: [changed, ...current.items.filter((item) => item.id !== changed.id)],
            }
          : current,
      )
      if (action === 'fork' || action === 'archive') {
        setShowArchived(changed.archived)
        setSessionQuery('')
      }
      selectSession(changed.id)
    } catch (cause) {
      setError(report(cause))
    } finally {
      setSessionBusy(false)
    }
  }

  const openReferences = () => {
    const input = promptInput.current
    // 打开选择器前记录光标位置，插入引用后按此位置回填。
    if (input) referenceSelection.current = [input.selectionStart, input.selectionEnd]
    setReferenceOpen(true)
  }

  const insertReference = (path: string) => {
    const [start, end] = referenceSelection.current
    const reference = `\`${path}\``
    // 仅当光标前一个字符不是空白时补空格，保证引用与已有文本分开。
    const prefix = start > 0 && !/\s$/.test(prompt.slice(0, start)) ? ' ' : ''
    const inserted = `${prefix}${reference} `
    const next = prompt.slice(0, start) + inserted + prompt.slice(end)
    // 超出输入上限时放弃插入，避免静默截断。
    if (next.length > 16000) return
    setPrompt(next)
    setReferenceOpen(false)
    // 等 React 更新 value 后再恢复焦点与光标，否则会被重置到末尾。
    requestAnimationFrame(() => {
      promptInput.current?.focus()
      promptInput.current?.setSelectionRange(start + inserted.length, start + inserted.length)
    })
  }

  const send = async () => {
    const text = prompt.trim()
    if (!session || !ready || !text || sessionBusy || rewriting || request.current) return
    const controller = new AbortController()
    request.current = controller
    setError('')
    // pending 承载本次流式回复的临时状态：用户消息、增量文本与工具调用。
    setPending({ user: text, answer: '', tools: [] })
    // 发出新消息即作废上一轮的后续建议与改写撤销点。
    suggestionRequest.current?.abort()
    setSuggestion(undefined)
    setRewriteUndo(undefined)
    setPrompt('')
    try {
      const final = await streamCoding(session.id, text, mode, controller.signal, (event) => {
        if (event.type === 'started') {
          // 首条消息后后端可能自动生成标题，这里同步到会话列表。
          setSessions(
            (current) =>
              current && {
                ...current,
                items: current.items.map((item) =>
                  item.id === session.id ? { ...item, title: event.title } : item,
                ),
              },
          )
        }
        if (event.type === 'delta') {
          // 增量文本逐段追加，保持打字机效果。
          setPending((current) => current && { ...current, answer: current.answer + event.text })
        }
        if (event.type === 'tool') {
          setPending((current) => current && { ...current, tools: [...current.tools, event] })
        }
        // 后端写入了项目文件时通知右侧工作面板刷新对应文件。
        if (event.type === 'changed') setWorkspaceUpdate({ path: event.path })
      })
      setHistory({
        session: session.id,
        messages: [
          ...messages,
          { id: -final.id, role: 'user', content: text, status: 'complete' },
          final,
        ],
      })
      if (enhancements?.suggestions && final.status === 'complete') {
        // 仅完整回复才生成后续建议，避免中断/失败时请求模型。
        const request = new AbortController()
        suggestionRequest.current = request
        codingAPI
          .suggestion(session.id, request.signal)
          .then((text) => {
            if (!request.signal.aborted && text) setSuggestion({ session: session.id, text })
          })
          .catch(() => undefined)
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(report(cause))
        // 失败时把输入还原到输入框，方便用户重试。
        setPrompt(text)
        // 流式中途失败可能已落库部分消息，重新拉取以保证历史一致。
        const items = await codingAPI.messages(session.id, controller.signal).catch(() => undefined)
        if (items && !controller.signal.aborted)
          setHistory({ session: session.id, messages: items })
      }
    } finally {
      if (!controller.signal.aborted) {
        request.current = null
        setPending(undefined)
        setStopping(false)
      }
    }
  }

  const stop = () => {
    if (!session || stopping) return
    setStopping(true)
    codingAPI.stop(session.id).catch((cause) => {
      setError(report(cause))
      setStopping(false)
    })
  }

  const lastMessage = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // 消息增加或流式文本/工具更新时贴底滚动；依赖具体长度而非数组引用以覆盖增量场景。
    const transcript = lastMessage.current
    if (transcript) transcript.scrollTop = transcript.scrollHeight
  }, [messages.length, pending?.answer, pending?.tools.length])

  return (
    <div
      className="coding-page"
      style={theme ? ({ ...theme.tokens, colorScheme: theme.base } as CSSProperties) : undefined}
    >
      <aside className="coding-projects" aria-label="编码项目和会话">
        <header className="coding-panel-bar">
          <strong>项目</strong>
          <button
            type="button"
            className="coding-icon"
            aria-label="打开项目"
            disabled={working || projectBusy}
            onClick={() => (desktop ? void addProject(true) : setAddOpen((open) => !open))}
          >
            <FolderOpen size={17} />
          </button>
        </header>
        {addOpen && (
          <form
            className="coding-open-form"
            onSubmit={(event) => {
              event.preventDefault()
              void addProject()
            }}
          >
            <label htmlFor="coding-project-path">项目目录</label>
            <input
              id="coding-project-path"
              placeholder="项目绝对路径"
              value={projectPath}
              autoFocus
              onChange={(event) => setProjectPath(event.target.value)}
            />
            <div>
              <button
                type="button"
                className="coding-icon"
                aria-label="取消打开项目"
                onClick={() => setAddOpen(false)}
              >
                <X size={14} />
              </button>
              <button className="coding-button" disabled={!projectPath.trim() || projectBusy}>
                打开
              </button>
            </div>
          </form>
        )}
        <div className="coding-project-list">
          {projects.map((item) => (
            <button
              key={item.id}
              title={item.path}
              aria-pressed={item.id === project?.id}
              disabled={working || sessionBusy || projectBusy}
              onClick={() => {
                if (item.id !== project?.id) selectProject(item.id)
              }}
            >
              <FolderOpen size={15} />
              <span>{item.name}</span>
            </button>
          ))}
        </div>
        {project && (
          <>
            <header className="coding-panel-bar coding-session-heading">
              <strong>会话</strong>
              <div className="coding-actions">
                <button
                  type="button"
                  className="coding-icon"
                  aria-label="归档会话列表"
                  title="归档会话列表"
                  aria-pressed={showArchived}
                  disabled={working || sessionBusy}
                  onClick={() => {
                    setShowArchived(!showArchived)
                    setSessionQuery('')
                    selectSession('')
                  }}
                >
                  <Archive size={15} />
                </button>
                <button
                  type="button"
                  className="coding-icon"
                  aria-label="新建编码会话"
                  disabled={working || sessionBusy || sessions?.project !== project.id}
                  onClick={() => void newSession()}
                >
                  <Plus size={17} />
                </button>
              </div>
            </header>
            <div className="coding-session-list">
              {shownSessions.length > 0 && (
                <input
                  className="coding-session-search"
                  aria-label="筛选会话名称"
                  placeholder={showArchived ? '筛选归档会话' : '筛选会话'}
                  value={sessionQuery}
                  onChange={(event) => setSessionQuery(event.target.value)}
                />
              )}
              {matchingSessions.map((item) => (
                <button
                  key={item.id}
                  title={item.title}
                  aria-pressed={item.id === session?.id}
                  disabled={working || sessionBusy}
                  onClick={() => selectSession(item.id)}
                >
                  <MessageSquare size={14} />
                  <span>{item.title}</span>
                </button>
              ))}
              {sessionQuery.trim() && !matchingSessions.length && (
                <p className="coding-muted">没有匹配的会话</p>
              )}
            </div>
            {session && (
              <div className="coding-session-actions">
                {titleDraft !== undefined ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (titleDraft.trim()) void manageSession('rename')
                    }}
                  >
                    <input
                      autoFocus
                      maxLength={80}
                      aria-label="会话名称"
                      value={titleDraft}
                      onChange={(event) => setTitleDraft(event.target.value)}
                    />
                    <div className="coding-actions">
                      <button
                        type="button"
                        className="coding-button"
                        onClick={() => setTitleDraft(undefined)}
                      >
                        取消
                      </button>
                      <button
                        className="coding-button coding-primary"
                        disabled={sessionBusy || !titleDraft.trim()}
                      >
                        保存
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="coding-actions">
                    <button
                      type="button"
                      className="coding-icon"
                      aria-label="重命名会话"
                      title="重命名会话"
                      disabled={working || sessionBusy}
                      onClick={() => setTitleDraft(session.title)}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      type="button"
                      className="coding-icon"
                      aria-label="创建会话分支"
                      title="创建会话分支"
                      disabled={working || sessionBusy}
                      onClick={() => void manageSession('fork')}
                    >
                      <GitBranch size={15} />
                    </button>
                    <button
                      type="button"
                      className="coding-icon"
                      aria-label={session.archived ? '恢复此会话' : '归档此会话'}
                      title={session.archived ? '恢复此会话' : '归档此会话'}
                      disabled={working || sessionBusy}
                      onClick={() => void manageSession('archive')}
                    >
                      {session.archived ? <RotateCcw size={15} /> : <Archive size={15} />}
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </aside>

      <section className="coding-conversation" aria-label="Pi 编码会话">
        <header className="coding-conversation-bar">
          <div>
            <h1>编码模式</h1>
            {project && (
              <p title={project.path}>
                <GitBranch size={13} />
                {project.name}
                {session && ` / ${session.title}`}
              </p>
            )}
          </div>
          <div className="coding-actions coding-header-actions">
            {runtimePlugins.length > 0 && (
              <button
                type="button"
                className="coding-icon"
                aria-label="插件命令与面板"
                title="插件命令与面板"
                onClick={() => setPluginDialog(true)}
              >
                <Boxes size={17} />
              </button>
            )}
            {themes.length > 0 && (
              <Select
                value={theme?.id || '__default__'}
                onValueChange={(id) => {
                  const next = id === '__default__' ? '' : id
                  setThemeID(next)
                  localStorage.setItem('studio-coding-theme', next)
                }}
              >
                <SelectTrigger className="coding-theme-select" aria-label="编码工作台配色">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">默认配色</SelectItem>
                  {themes.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Link
              to="/coding/plugins"
              className="coding-icon"
              aria-label="插件中心"
              title="插件中心"
            >
              <Puzzle size={17} />
            </Link>
            {enhancementEnabled && (
              <Link
                to="/coding/enhancements"
                className="coding-icon"
                aria-label="增强设置"
                title="增强设置"
              >
                <Sparkles size={17} />
              </Link>
            )}
            {session ? (
              <CodingSessionModel
                key={session.id}
                session={session.id}
                disabled={working || sessionBusy || orchestrationBusy || session.archived}
              />
            ) : (
              <Link to="/coding/settings" className="coding-model" title="配置语言模型">
                {model || '配置模型'}
              </Link>
            )}
          </div>
        </header>
        {session && !session.archived && (
          <CodingOrchestration
            key={session.id}
            session={session}
            busy={working || sessionBusy}
            onBusyChange={setOrchestrationBusy}
            onOpenSession={(id) => {
              const projectID = session.project_id
              codingAPI
                .sessions(projectID)
                .then((items) => {
                  setSessions((current) =>
                    current?.project === projectID ? { project: projectID, items } : current,
                  )
                  selectSession(id)
                })
                .catch((cause) => setError(report(cause)))
            }}
            onSettled={() => {
              const id = session.id
              codingAPI
                .messages(id)
                .then((items) => {
                  setHistory((current) =>
                    current?.session === id ? { session: id, messages: items } : current,
                  )
                  setWorkspaceUpdate({ path: '' })
                })
                .catch((cause) => setError(report(cause)))
            }}
          />
        )}
        {runtime && !runtime.ready && (
          // 运行时就绪前无法建立会话，给出提示并允许手动重新检查。
          <div className="coding-runtime-notice" role="status">
            <span>{runtime.message}</span>
            <button
              className="coding-icon"
              aria-label="重新检查 Pi 运行时"
              onClick={() => void refreshRuntime()}
            >
              <RefreshCw size={15} />
            </button>
          </div>
        )}
        <div className="coding-transcript" ref={lastMessage} aria-label="会话消息">
          {!session && (
            <div className="coding-empty">
              <Braces size={28} />
              <h2>{showArchived ? '暂无归档会话' : project ? '开始编码会话' : '打开本地项目'}</h2>
              {!showArchived && (
                <button
                  type="button"
                  className="coding-button coding-primary"
                  disabled={
                    projectBusy || sessionBusy || (!!project && sessions?.project !== project.id)
                  }
                  onClick={() =>
                    project ? void newSession() : desktop ? void addProject(true) : setAddOpen(true)
                  }
                >
                  {project ? '新建会话' : '打开项目'}
                </button>
              )}
            </div>
          )}
          {session && messages.length === 0 && !pending && (
            <div className="coding-empty">
              <Braces size={28} />
              <h2>描述要处理的编码任务</h2>
            </div>
          )}
          {messages.map((message) => (
            <article key={message.id} className={`coding-message coding-message-${message.role}`}>
              <strong>{message.role === 'user' ? '你' : 'Pi'}</strong>
              <ToolLog tools={message.tools} />
              <ReactMarkdown disallowedElements={['img']}>{message.content}</ReactMarkdown>
              {message.error && <p className="coding-alert">{message.error}</p>}
              {(message.status === 'interrupted' || message.status === 'streaming') && (
                <p className="coding-muted">已中断</p>
              )}
            </article>
          ))}
          {pending && (
            <>
              <article className="coding-message coding-message-user">
                <strong>你</strong>
                <p>{pending.user}</p>
              </article>
              <article className="coding-message coding-message-assistant">
                <strong>Pi</strong>
                <ToolLog tools={pending.tools} />
                {pending.answer ? (
                  <ReactMarkdown disallowedElements={['img']}>{pending.answer}</ReactMarkdown>
                ) : (
                  <p className="coding-muted" role="status">
                    正在处理…
                  </p>
                )}
              </article>
            </>
          )}
        </div>
        {error && (
          <p className="coding-alert" role="alert">
            {error}
          </p>
        )}
        {session?.archived && (
          <p className="coding-muted coding-archived-notice">
            此会话已归档，恢复后可继续发送消息。
          </p>
        )}
        {session && !session.archived && project && (
          <form
            className="coding-composer"
            onSubmit={(event) => {
              event.preventDefault()
              void send()
            }}
          >
            {referenceOpen && (
              <CodingFileSearch
                project={project.id}
                onChoose={insertReference}
                onClose={() => {
                  setReferenceOpen(false)
                  promptInput.current?.focus()
                }}
              />
            )}
            <Textarea
              ref={promptInput}
              aria-label="编码任务"
              placeholder={suggestedText || '描述任务，可在消息中注明项目内的文件路径'}
              rows={3}
              maxLength={16000}
              disabled={working || sessionBusy}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                // Tab 仅在输入框为空时采用后续建议，避免覆盖已有草稿。
                if (event.key === 'Tab' && !event.shiftKey && !prompt && suggestedText) {
                  event.preventDefault()
                  setPrompt(suggestedText)
                  setSuggestion(undefined)
                }
                // Esc 放弃当前建议。
                if (event.key === 'Escape' && suggestedText) setSuggestion(undefined)
                // @ 只在行首或空白后触发文件引用，避免干扰邮箱等普通文本。
                if (
                  event.key === '@' &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  (event.currentTarget.selectionStart === 0 ||
                    /\s$/.test(prompt.slice(0, event.currentTarget.selectionStart)))
                ) {
                  event.preventDefault()
                  openReferences()
                }
                // Ctrl/Cmd+Enter 发送，保留 Enter 换行的默认行为。
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            {!prompt && suggestedText && (
              <button
                type="button"
                className="coding-muted"
                onClick={() => {
                  setPrompt(suggestedText)
                  setSuggestion(undefined)
                  promptInput.current?.focus()
                }}
              >
                Tab 采用后续建议
              </button>
            )}
            <div className="coding-composer-actions">
              <div className="coding-actions">
                <button
                  type="button"
                  className="coding-icon"
                  aria-label="引用项目文件"
                  title="引用项目文件"
                  aria-expanded={referenceOpen}
                  disabled={working || sessionBusy}
                  onClick={() => (referenceOpen ? setReferenceOpen(false) : openReferences())}
                >
                  <AtSign size={16} />
                </button>
                {enhancements?.rewrite && (
                  <button
                    type="button"
                    className="coding-icon"
                    aria-label="增强提示词"
                    title="增强提示词"
                    disabled={working || rewriting || !prompt.trim()}
                    onClick={() => void rewritePrompt()}
                  >
                    <Sparkles size={16} />
                  </button>
                )}
                {rewriteUndo && prompt === rewriteUndo.after && (
                  // 仅当输入框仍是增强后的文本时才提供撤销，防止覆盖用户新输入。
                  <button
                    type="button"
                    className="coding-icon"
                    aria-label="撤销提示词增强"
                    title="撤销提示词增强"
                    onClick={() => {
                      setPrompt(rewriteUndo.before)
                      setRewriteUndo(undefined)
                    }}
                  >
                    <RotateCcw size={15} />
                  </button>
                )}
                <Select
                  value={mode}
                  disabled={working}
                  onValueChange={(value) => setMode(value as CodingMode)}
                >
                  <SelectTrigger aria-label="编码工作方式">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="plan">计划 · 只读</SelectItem>
                    <SelectItem value="agent">编码 · 可编辑文件</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {working ? (
                // 流式回复期间只能停止；stopping 时禁用按钮防止重复请求。
                <button type="button" className="coding-button" disabled={stopping} onClick={stop}>
                  <Square size={14} />
                  {stopping ? '正在停止…' : '停止'}
                </button>
              ) : (
                <button
                  type="submit"
                  className="coding-button coding-primary"
                  disabled={!ready || !prompt.trim() || sessionBusy || rewriting}
                >
                  <ArrowUp size={16} />
                  发送
                </button>
              )}
            </div>
          </form>
        )}
      </section>
      {project ? (
        // 项目或 URL 面板参数变化时重建面板，确保初始标签与项目上下文一致。
        <CodingWorkPanel
          key={`${project.id}-${requestedPanel}`}
          project={project}
          update={workspaceUpdate}
          filePlugin={filePlugin}
          browserPlugin={browserPlugin}
          initialTab={requestedPanel}
          runtimePlugins={runtimePlugins}
          sessionID={session?.id}
          onQuote={(reference) => {
            // 归档/运行中的会话视为只读，引用前先拦截并提示。
            if (!session || session.archived || working) {
              setError('打开可编辑的编码会话后再引用文件')
              return
            }
            // 引用追加到末尾并保留一个空格分隔，同时遵守输入长度上限。
            setPrompt((value) =>
              `${value.trimEnd()}${value.trim() ? ' ' : ''}\`${reference}\` `.slice(0, 16000),
            )
            promptInput.current?.focus()
          }}
        />
      ) : (
        browserPlugin &&
        requestedPanel === 'browser' && (
          <aside className="coding-workpanel">
            <CodingBrowserPanel />
          </aside>
        )
      )}
      {(requestedPlugin || pluginDialog) && (
        <CodingPluginRuntime
          key={requestedPlugin || 'runtime'}
          plugins={runtimePlugins}
          initialPlugin={requestedPlugin}
          workspace={project ? { project_id: project.id, session_id: session?.id } : undefined}
          open
          onOpenChange={(open) => {
            setPluginDialog(open)
            if (!open && requestedPlugin) {
              const query = new URLSearchParams(searchParams)
              query.delete('plugin')
              setSearchParams(query, { replace: true })
            }
          }}
        />
      )}
    </div>
  )
}
