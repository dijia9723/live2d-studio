import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Download,
  FileUp,
  FolderTree,
  Globe2,
  PackageOpen,
  Puzzle,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { piPluginsAPI } from '../api/piplugins'
import type { PiMarketplacePlugin, PiPlugin } from '../api/piplugins'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog'
import CodingStdioSettings from '../components/CodingStdioSettings'
import CodingTrustedExtension from '../components/CodingTrustedExtension'
import '../assets/piplugins.css'

type Plugin = PiPlugin | PiMarketplacePlugin
type View = 'installed' | 'marketplace'
type PluginDialog = { action: 'details' | 'enable' | 'remove' | 'install'; plugin: Plugin }

const sourceNames = { bundled: '内置', local: '本地导入', marketplace: '插件市场' }
const capabilities: Record<string, string> = {
  commands: '工作台命令',
  panels: '独立面板',
  panel: '独立面板',
  workPanelViews: '工作面板',
  work_panel_views: '工作面板',
  views: '工作面板',
  widgets: '悬浮组件',
  floatingWidgets: '悬浮组件',
  agentTools: 'Agent 工具',
  tools: 'Agent 工具',
  skills: 'Skills',
  mcpServers: 'MCP 服务',
  mcpStdio: '本地 MCP 进程',
  mcp: 'MCP 服务',
  themes: '主题',
  services: '后台服务',
  residentServices: '后台服务',
  composerTransforms: '输入框处理',
  composerSuggestions: '输入建议',
  autoTitle: '自动命名会话',
  messageBus: '插件消息总线',
  extensions: 'Pi 扩展',
  agentExtensions: '可信 Pi 扩展',
  settings: '插件设置',
}

const marketPageSize = 24
const hostCapabilities = new Set([
  'commands',
  'views',
  'panel',
  'settings',
  'agentTools',
  'services',
  'bus',
])
const builtins = {
  'pi.file-manager': { icon: FolderTree, route: '/coding?panel=files', link: '打开文件面板' },
  'pi.browser': { icon: Globe2, route: '/coding?panel=browser', link: '打开浏览器面板' },
  'pi.official-enhancements': { icon: Sparkles, route: '/coding/enhancements', link: '打开设置' },
} as const

function installed(plugin: Plugin): plugin is PiPlugin {
  return 'source' in plugin
}

function capabilityName(value: string) {
  return Object.hasOwn(capabilities, value) ? capabilities[value] : value
}

function description(error: unknown) {
  return error instanceof Error ? error.message : '插件操作失败'
}

function externalLink(value: string | undefined) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

function PluginCard({
  plugin,
  installedPlugin,
  busy,
  onDetails,
  onPrimary,
}: {
  plugin: Plugin
  installedPlugin?: PiPlugin
  busy: boolean
  onDetails: () => void
  onPrimary?: () => void
}) {
  const builtin = Object.hasOwn(builtins, plugin.id)
    ? builtins[plugin.id as keyof typeof builtins]
    : undefined
  const Icon = builtin?.icon ?? Puzzle
  const isInstalled = installed(plugin)
  const archiveError = isInstalled ? plugin.error : installedPlugin?.error
  const status = isInstalled
    ? archiveError
      ? '插件文件异常'
      : plugin.enabled
        ? '已启用'
        : plugin.supported?.length
          ? '已停用'
          : '待兼容'
    : installedPlugin
      ? `已安装 ${installedPlugin.version}`
      : ''
  const action = isInstalled
    ? plugin.enabled
      ? '停用'
      : '启用'
    : archiveError
      ? '重新安装'
      : installedPlugin
        ? '选择版本'
        : '安装'

  return (
    <article className="pi-plugin-card">
      <header>
        <span className="pi-plugin-icon">
          <Icon size={20} aria-hidden="true" />
        </span>
        <div className="pi-plugin-name">
          <h2>{plugin.name || plugin.id}</h2>
          <p>{plugin.id}</p>
        </div>
        {isInstalled && <span className="pi-plugin-status">{sourceNames[plugin.source]}</span>}
      </header>
      {plugin.description && <p className="pi-plugin-summary">{plugin.description}</p>}
      {isInstalled && archiveError && (
        <p className="pi-plugins-error">{archiveError}。请重新导入或从插件市场重装。</p>
      )}
      <div className="pi-plugin-meta">
        {plugin.version && <span className="pi-plugin-version">{plugin.version}</span>}
        {plugin.author && <span>{plugin.author}</span>}
        {status && (
          <span
            className="pi-plugin-status"
            data-enabled={isInstalled && plugin.enabled && !archiveError}
          >
            {status}
          </span>
        )}
      </div>
      <div className="pi-plugin-card-actions">
        <button
          type="button"
          className="pi-plugin-button"
          aria-label={`查看 ${plugin.name || plugin.id} 详情`}
          onClick={onDetails}
        >
          详情
        </button>
        {isInstalled && plugin.enabled && builtin && (
          <Link to={builtin.route} className="pi-plugin-button">
            {builtin.link}
            <ArrowUpRight size={13} />
          </Link>
        )}
        {onPrimary && (
          <button
            type="button"
            className="pi-plugin-button"
            data-primary={!(isInstalled && plugin.enabled)}
            disabled={busy}
            aria-label={`${action} ${plugin.name || plugin.id}`}
            onClick={onPrimary}
          >
            {!isInstalled && <Download size={14} />}
            {action}
          </button>
        )}
      </div>
    </article>
  )
}

export default function CodingPluginsPage() {
  const [view, setView] = useState<View>('installed')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [managed, setManaged] = useState<PiPlugin[]>()
  const [marketplace, setMarketplace] = useState<PiMarketplacePlugin[]>()
  const [managedError, setManagedError] = useState('')
  const [marketError, setMarketError] = useState('')
  const [managedRequest, setManagedRequest] = useState(0)
  const [marketRequest, setMarketRequest] = useState(0)
  const [operation, setOperation] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [dialog, setDialog] = useState<PluginDialog>()
  const [version, setVersion] = useState('')
  const [desktop, setDesktop] = useState(false)
  const [execute, setExecute] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const haveMarketplace = marketplace !== undefined
  const haveMarketError = Boolean(marketError)

  useEffect(() => {
    let active = true
    api
      .desktop()
      .then((value) => {
        if (active) setDesktop(value.available)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    piPluginsAPI
      .list(controller.signal)
      .then((list) => {
        if (!controller.signal.aborted) setManaged(list)
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setManagedError(description(cause))
      })
    return () => controller.abort()
  }, [managedRequest])

  useEffect(() => {
    if (view !== 'marketplace' || haveMarketplace || haveMarketError) return
    const controller = new AbortController()
    piPluginsAPI
      .marketplace(controller.signal)
      .then((list) => {
        if (!controller.signal.aborted) setMarketplace(list)
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setMarketError(description(cause))
      })
    return () => controller.abort()
  }, [view, haveMarketplace, haveMarketError, marketRequest])

  const changeView = (next: View) => {
    setView(next)
    setQuery('')
    setPage(1)
  }

  const refresh = () => {
    if (view === 'installed') {
      setManagedError('')
      setManaged(undefined)
      setManagedRequest((value) => value + 1)
    } else {
      setMarketError('')
      setMarketplace(undefined)
      setMarketRequest((value) => value + 1)
    }
  }

  const updateInstalled = (plugin: PiPlugin) => {
    setManaged((list) => [...(list ?? []).filter((item) => item.id !== plugin.id), plugin])
  }

  const mutate = async (action: () => Promise<void>) => {
    if (operation) return
    setOperation(true)
    setError('')
    setNotice('')
    try {
      await action()
      setDialog(undefined)
    } catch (cause) {
      setError(description(cause))
    } finally {
      setOperation(false)
    }
  }

  const openDialog = (action: PluginDialog['action'], plugin: Plugin) => {
    setError('')
    setExecute(installed(plugin) && plugin.host_granted === true)
    setVersion(
      'versions' in plugin
        ? (plugin.versions.includes(plugin.version) ? plugin.version : plugin.versions[0]) || ''
        : '',
    )
    setDialog({ action, plugin })
  }

  const setEnabled = (plugin: PiPlugin, enabled: boolean, run?: boolean) =>
    mutate(async () => {
      const updated = await piPluginsAPI.setEnabled(plugin.id, enabled, run)
      updateInstalled({
        ...updated,
        error: enabled ? updated.error : (plugin.error ?? updated.error),
      })
      setNotice(`${plugin.name || plugin.id} 已${enabled ? '启用' : '停用'}`)
    })

  const importFile = (file: File) =>
    mutate(async () => {
      if (!file.name.toLowerCase().endsWith('.piplug')) throw new Error('请选择 .piplug 插件包')
      const plugin = await piPluginsAPI.importFile(file)
      updateInstalled(plugin)
      changeView('installed')
      setNotice(`${plugin.name || plugin.id} 已导入`)
    })

  const confirmAction = () => {
    if (!dialog) return
    const { action, plugin } = dialog
    if (action === 'enable' && installed(plugin)) {
      void setEnabled(plugin, true, execute)
    } else if (action === 'remove') {
      void mutate(async () => {
        await piPluginsAPI.remove(plugin.id)
        setManaged((list) => list?.filter((item) => item.id !== plugin.id))
        setNotice(`${plugin.name || plugin.id} 已卸载`)
      })
    } else if (action === 'install') {
      void mutate(async () => {
        const added = await piPluginsAPI.install(plugin.id, version || undefined)
        updateInstalled(added)
        changeView('installed')
        setNotice(`${added.name || added.id} 已安装`)
      })
    }
  }

  const activeList = view === 'installed' ? managed : marketplace
  const fetchError = view === 'installed' ? managedError : marketError
  const search = query.trim().toLowerCase()
  const ordered = [...(activeList ?? [])]
    .sort(
      (a, b) =>
        Number(installed(b) && b.source === 'bundled') -
          Number(installed(a) && a.source === 'bundled') ||
        (a.name || a.id).localeCompare(b.name || b.id),
    )
    .filter((plugin) =>
      [
        plugin.name,
        plugin.id,
        plugin.description,
        plugin.author,
        ...('categories' in plugin ? (plugin.categories ?? []) : []),
      ].some((text) => text?.toLowerCase().includes(search)),
    )
  const pageCount = Math.ceil(ordered.length / marketPageSize)
  const activePage = Math.max(1, Math.min(pageCount, page))
  const visiblePlugins =
    view === 'installed'
      ? ordered
      : ordered.slice((activePage - 1) * marketPageSize, activePage * marketPageSize)
  const selected = dialog?.plugin
  const selectedInstalled = selected && installed(selected) ? selected : undefined
  const selectedVersions = selected && 'versions' in selected ? selected.versions : []
  const installedSelection = selected && managed?.find((item) => item.id === selected.id)
  const installedVersion = installedSelection?.version
  const hasRuntime =
    selectedInstalled?.source !== 'bundled' &&
    !!selectedInstalled?.supported?.some((name) => hostCapabilities.has(name))
  const dialogTitle =
    dialog?.action === 'enable'
      ? '启用插件'
      : dialog?.action === 'remove'
        ? '卸载插件'
        : dialog?.action === 'install'
          ? '安装插件'
          : '插件详情'

  return (
    <div className="pi-plugins-page">
      <div className="pi-plugins-body">
        <Link className="pi-plugins-back" to="/coding">
          <ArrowLeft size={16} /> 返回编码工作台
        </Link>
        <header className="pi-plugins-header">
          <h1>插件中心</h1>
          <button
            type="button"
            className="pi-plugin-button"
            data-primary="true"
            disabled={operation || !managed}
            onClick={() => fileInput.current?.click()}
          >
            <FileUp size={17} /> 导入插件
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".piplug"
            aria-label="导入 .piplug 插件包"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file) void importFile(file)
            }}
          />
        </header>
        <div className="pi-plugins-toolbar">
          <div className="pi-plugins-views" role="group" aria-label="插件来源">
            <button
              type="button"
              aria-pressed={view === 'installed'}
              onClick={() => changeView('installed')}
            >
              已安装
            </button>
            <button
              type="button"
              aria-pressed={view === 'marketplace'}
              onClick={() => changeView('marketplace')}
            >
              PI-Desktop 插件市场
            </button>
          </div>
          <div className="pi-plugins-filters">
            <label className="pi-plugins-search">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                aria-label="搜索插件"
                placeholder="搜索名称、作者或插件 ID"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setPage(1)
                }}
              />
            </label>
            <button
              type="button"
              className="pi-plugin-button pi-plugin-refresh"
              title="刷新列表"
              aria-label="刷新列表"
              disabled={operation || (!activeList && !fetchError)}
              onClick={refresh}
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </div>
        {operation && !dialog && (
          <p className="pi-plugins-notice" role="status">
            正在更新插件…
          </p>
        )}
        {notice && (
          <p className="pi-plugins-notice" role="status">
            {notice}
          </p>
        )}
        {error && !dialog && (
          <p className="pi-plugins-error" role="alert">
            {error}
          </p>
        )}
        {fetchError ? (
          <div className="pi-plugins-empty" role="alert">
            <p>{fetchError}</p>
            <button type="button" className="pi-plugin-button" onClick={refresh}>
              重试
            </button>
          </div>
        ) : !activeList ? (
          <p className="pi-plugins-empty" role="status">
            {view === 'installed' ? '正在读取插件…' : '正在读取插件市场…'}
          </p>
        ) : ordered.length === 0 ? (
          <div className="pi-plugins-empty">
            <PackageOpen size={28} aria-hidden="true" />
            <p>
              {search
                ? '没有符合条件的插件'
                : view === 'installed'
                  ? '暂无已安装插件'
                  : '插件市场暂无可用条目'}
            </p>
          </div>
        ) : (
          <div className="pi-plugins-grid">
            {visiblePlugins.map((plugin) => {
              const local = managed?.find((item) => item.id === plugin.id)
              let onPrimary: (() => void) | undefined
              if (installed(plugin)) {
                if (plugin.enabled) onPrimary = () => void setEnabled(plugin, false)
                else if (plugin.supported?.length && !plugin.error) {
                  onPrimary =
                    plugin.source === 'bundled'
                      ? () => void setEnabled(plugin, true)
                      : () => openDialog('enable', plugin)
                }
              } else if (
                local?.source !== 'bundled' &&
                plugin.versions.length > 0 &&
                (local?.error || local?.version !== plugin.version || plugin.versions.length > 1)
              ) {
                onPrimary = () => openDialog('install', plugin)
              }
              return (
                <PluginCard
                  key={plugin.id}
                  plugin={plugin}
                  installedPlugin={local}
                  busy={operation || !managed}
                  onDetails={() => openDialog('details', plugin)}
                  onPrimary={onPrimary}
                />
              )
            })}
          </div>
        )}
        {view === 'marketplace' && pageCount > 1 && (
          <nav className="pi-plugin-pagination" aria-label="插件市场分页">
            <button
              type="button"
              className="pi-plugin-button"
              aria-label="上一页"
              disabled={activePage <= 1}
              onClick={() => setPage(activePage - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span aria-live="polite">
              第 {activePage} / {pageCount} 页
            </span>
            <button
              type="button"
              className="pi-plugin-button"
              aria-label="下一页"
              disabled={activePage >= pageCount}
              onClick={() => setPage(activePage + 1)}
            >
              <ChevronRight size={16} />
            </button>
          </nav>
        )}
      </div>
      <Dialog
        open={Boolean(dialog)}
        onOpenChange={(open) => {
          if (!open && !operation) {
            setDialog(undefined)
            setError('')
          }
        }}
      >
        {selected && dialog && (
          <DialogContent className="pi-plugin-dialog" showCloseButton={!operation}>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription className="pi-plugin-dialog-name">
              {selected.name || selected.id}
            </DialogDescription>
            {dialog.action === 'remove' ? (
              <p>将从插件中心移除此插件。日后可通过插件包或插件市场重新安装。</p>
            ) : (
              <>
                {selected.description && <p>{selected.description}</p>}
                {selectedInstalled?.error && (
                  <p className="pi-plugins-error">
                    {selectedInstalled.error}。请重新导入或从插件市场重装。
                  </p>
                )}
                <dl className="pi-plugin-details">
                  <dt>插件 ID</dt>
                  <dd>{selected.id}</dd>
                  {selected.author && (
                    <>
                      <dt>作者</dt>
                      <dd>{selected.author}</dd>
                    </>
                  )}
                  {selected.version && dialog.action !== 'install' && (
                    <>
                      <dt>版本</dt>
                      <dd>{selected.version}</dd>
                    </>
                  )}
                  {selectedInstalled && (
                    <>
                      <dt>来源</dt>
                      <dd>{sourceNames[selectedInstalled.source]}</dd>
                    </>
                  )}
                  {'verified' in selected && selected.verified && (
                    <>
                      <dt>发布信息</dt>
                      <dd>市场已验证</dd>
                    </>
                  )}
                  {'categories' in selected && !!selected.categories?.length && (
                    <>
                      <dt>分类</dt>
                      <dd>{selected.categories.join('、')}</dd>
                    </>
                  )}
                </dl>
                {dialog.action === 'install' && selectedVersions.length > 0 && (
                  <label className="pi-plugin-version-select">
                    安装版本
                    <select
                      disabled={operation}
                      value={version}
                      onChange={(event) => setVersion(event.target.value)}
                    >
                      {selectedVersions.map((item) => (
                        <option key={item} value={item}>
                          {item}
                          {item === installedVersion &&
                            (installedSelection?.error ? '（文件异常）' : '（已安装）')}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {!!selected.permissions?.length && (
                  <div className="pi-plugin-details-group">
                    <h3>声明的权限</h3>
                    <ul>
                      {selected.permissions.map((item) => (
                        <li key={item}>
                          <code>{item}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {!!selected.contributions?.length && (
                  <div className="pi-plugin-details-group">
                    <h3>插件能力</h3>
                    <ul>
                      {selected.contributions.map((item) => (
                        <li key={item}>{capabilityName(item)}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {selectedInstalled && (
                  <div className="pi-plugin-details-group">
                    <h3>本工作台支持</h3>
                    {selectedInstalled.supported?.length ? (
                      <ul>
                        {selectedInstalled.supported.map((item) => (
                          <li key={item}>{capabilityName(item)}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>此插件暂时仅可管理安装包。</p>
                    )}
                  </div>
                )}
                {dialog.action === 'enable' && hasRuntime && (
                  <div className="pi-plugin-runtime-settings">
                    <label>
                      <input
                        type="checkbox"
                        checked={execute}
                        disabled={operation || !desktop}
                        onChange={(event) => setExecute(event.target.checked)}
                      />
                      授权在桌面插件宿主运行此包的 JavaScript 和面板
                    </label>
                    {!desktop && <p>在桌面客户端中可以确认此授权。</p>}
                  </div>
                )}
                {dialog.action === 'details' &&
                  selectedInstalled?.supported?.includes('mcpStdio') && (
                    <CodingStdioSettings key={selected.id} plugin={selected.id} desktop={desktop} />
                  )}
                {selected.safety_notes && (
                  <p className="pi-plugin-safety-notes">{selected.safety_notes}</p>
                )}
                {dialog.action === 'details' &&
                  selectedInstalled?.supported?.includes('agentExtensions') && (
                    <CodingTrustedExtension
                      key={selected.id}
                      plugin={selected.id}
                      desktop={desktop}
                    />
                  )}
                {dialog.action === 'details' &&
                  'readme_markdown' in selected &&
                  selected.readme_markdown && (
                    <div className="pi-plugin-readme">
                      <ReactMarkdown skipHtml disallowedElements={['img', 'a']} unwrapDisallowed>
                        {selected.readme_markdown}
                      </ReactMarkdown>
                    </div>
                  )}
                {dialog.action === 'details' && (selected.homepage || selected.repository) && (
                  <div className="pi-plugin-links">
                    {(['homepage', 'repository'] as const).map((key) => {
                      const href = externalLink(selected[key])
                      return (
                        href && (
                          <a key={key} href={href} target="_blank" rel="noreferrer noopener">
                            {key === 'homepage' ? '主页' : '源代码'} <ArrowUpRight size={13} />
                          </a>
                        )
                      )
                    })}
                  </div>
                )}
              </>
            )}
            {error && (
              <p className="pi-plugins-error" role="alert">
                {error}
              </p>
            )}
            <div className="pi-plugin-dialog-actions">
              {dialog.action === 'details' ? (
                <>
                  {selectedInstalled && selectedInstalled.source !== 'bundled' && (
                    <button
                      type="button"
                      className="pi-plugin-button"
                      data-danger="true"
                      disabled={operation}
                      onClick={() => openDialog('remove', selectedInstalled)}
                    >
                      卸载
                    </button>
                  )}
                  {selectedInstalled?.enabled && selected.id === 'pi.official-enhancements' && (
                    <Link className="pi-plugin-button" to="/coding/enhancements">
                      <Settings2 size={15} /> 设置
                    </Link>
                  )}
                  {selectedInstalled?.enabled && hasRuntime && (
                    <button
                      type="button"
                      className="pi-plugin-button"
                      disabled={operation}
                      onClick={() => openDialog('enable', selectedInstalled)}
                    >
                      运行权限
                    </button>
                  )}
                  {selectedInstalled?.enabled && selectedInstalled.host_granted && hasRuntime && (
                    <Link
                      className="pi-plugin-button"
                      to={`/coding?plugin=${encodeURIComponent(selected.id)}`}
                    >
                      打开插件
                    </Link>
                  )}
                  <button
                    type="button"
                    className="pi-plugin-button"
                    onClick={() => setDialog(undefined)}
                  >
                    关闭
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="pi-plugin-button"
                    disabled={operation}
                    onClick={() => {
                      setDialog(undefined)
                      setError('')
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="pi-plugin-button"
                    data-primary="true"
                    data-danger={dialog.action === 'remove'}
                    disabled={
                      operation ||
                      (dialog.action === 'install' &&
                        version === installedVersion &&
                        !installedSelection?.error)
                    }
                    onClick={confirmAction}
                  >
                    {operation ? '处理中…' : dialogTitle}
                  </button>
                </>
              )}
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}
