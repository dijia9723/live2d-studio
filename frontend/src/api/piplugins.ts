/**
 * 文件职责：编码工作台插件（Pi 插件）的接口。
 * 覆盖插件/主题/市场列表、导入安装、运行时命令与视图、MCP stdio 授权、设置读写等。
 */
import { http } from './client'

/** 插件元数据的公共字段（内置清单与市场清单共享）。 */
interface PluginMetadata {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  repository?: string
  safety_notes?: string
  permissions?: string[]
  contributions?: string[]
}

/** 已加载/已安装的插件；source 表示来源，host_granted 表示宿主侧已授权。 */
export interface PiPlugin extends PluginMetadata {
  source: 'bundled' | 'local' | 'marketplace'
  enabled: boolean
  supported: string[]
  installed_at?: string
  error?: string
  host_granted?: boolean
}

/** 市场中的插件条目；versions 为可安装版本，verified 表示官方校验通过。 */
export interface PiMarketplacePlugin extends PluginMetadata {
  versions: string[]
  categories?: string[]
  verified?: boolean
  readme_markdown?: string
}

/** 插件提供的界面主题；tokens 为 CSS 变量名到取值的映射。 */
export interface PiPluginTheme {
  id: string
  plugin_id: string
  label: string
  base: 'light' | 'dark'
  tokens: Record<string, string>
}

/** 插件声明的 MCP stdio 服务；approved/ready 分别表示用户授权与进程就绪。 */
export interface PiStdioServer {
  id: string
  label: string
  command: string
  args?: string[]
  environment: string[]
  settings: string[]
  approved: boolean
  ready: boolean
}

/** 插件宿主声明的设置项；type 决定前端渲染成开关、下拉或文本。 */
export interface PiHostSetting {
  key: string
  type: string
  title: string
  description?: string
  default?: unknown
  options?: (string | { value: string; label?: string })[]
}

/** 运行时插件；commands/views 为可触发的命令与面板。 */
export interface PiHostPlugin {
  id: string
  name: string
  commands?: { id: string; title: string }[]
  views?: { id: string; title: string; kind: 'panel' | 'view' }[]
  settings?: PiHostSetting[]
}

/** 插件运行过程中产生的一次性事件（Toast 或面板）。 */
export interface PiPluginEvent {
  type: 'toast' | 'panel'
  text?: string
  id?: string
  title?: string
}

/** 当前工作区上下文，供插件命令读取项目/会话信息。 */
export interface PiPluginWorkspace {
  project_id: string
  session_id?: string
}

/** 受信任扩展的授权状态；entries 为被放行的入口列表。 */
export interface PiTrustedExtension {
  version: string
  entries: string[]
  approved: boolean
  ready: boolean
}

// 插件 ID 直接拼进路径，必须编码以避免特殊字符破坏路由。
const endpoint = '/coding/plugins'
const pluginURL = (id: string) => `${endpoint}/${encodeURIComponent(id)}`

/** 统一解包列表接口的 data 字段。 */
async function list<T>(path: string, signal?: AbortSignal) {
  return (await http.get<{ data: T[] }>(path, { signal })).data.data
}

/** 插件相关的全部接口。 */
export const piPluginsAPI = {
  themes: (signal?: AbortSignal) => list<PiPluginTheme>(`${endpoint}/themes`, signal),
  list: (signal?: AbortSignal) => list<PiPlugin>(endpoint, signal),
  marketplace: (signal?: AbortSignal) =>
    list<PiMarketplacePlugin>(`${endpoint}/marketplace`, signal),
  // 走 multipart 上传，交给后端做清单与资源校验。
  importFile: async (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return (await http.post<{ data: PiPlugin }>(`${endpoint}/import`, form)).data.data
  },
  install: async (id: string, version?: string) =>
    (await http.post<{ data: PiPlugin }>(`${pluginURL(id)}/install`, { version })).data.data,
  setEnabled: async (id: string, enabled: boolean, execute?: boolean) =>
    (await http.put<{ data: PiPlugin }>(pluginURL(id), { enabled, execute })).data.data,
  runtime: (signal?: AbortSignal) => list<PiHostPlugin>(`${endpoint}/runtime`, signal),
  runtimeEvents: (signal?: AbortSignal) =>
    list<PiPluginEvent & { plugin_id: string }>(`${endpoint}/runtime/events`, signal),
  stdio: (id: string, signal?: AbortSignal) =>
    list<PiStdioServer>(`${pluginURL(id)}/stdio`, signal),
  setStdio: (id: string, server: string, approved: boolean, environment?: Record<string, string>) =>
    http.put(`${pluginURL(id)}/stdio/${encodeURIComponent(server)}`, { approved, environment }),
  trustedExtension: async (id: string, signal?: AbortSignal) =>
    (await http.get<{ data: PiTrustedExtension }>(`${pluginURL(id)}/trusted-extension`, { signal }))
      .data.data,
  grantExtension: async (id: string, version: string, approved: boolean) =>
    (
      await http.put<{ data: PiTrustedExtension }>(`${pluginURL(id)}/trusted-extension`, {
        version,
        approved,
      })
    ).data.data,
  settings: async (id: string, signal?: AbortSignal) =>
    (
      await http.get<{ data: Record<string, unknown> }>(`${pluginURL(id)}/runtime/settings`, {
        signal,
      })
    ).data.data,
  saveSettings: async (id: string, settings: Record<string, unknown>) =>
    (
      await http.put<{ data: Record<string, unknown> }>(
        `${pluginURL(id)}/runtime/settings`,
        settings,
      )
    ).data.data,
  command: async (id: string, command: string, context?: PiPluginWorkspace) =>
    (
      await http.post<{ data: { events?: PiPluginEvent[]; result?: unknown } }>(
        `${pluginURL(id)}/runtime/command`,
        { id: command, context },
      )
    ).data.data,
  pluginView: async (id: string, view: string) =>
    (
      await http.post<{ data: { html: string; title: string } }>(`${pluginURL(id)}/runtime/view`, {
        id: view,
      })
    ).data.data,
  bridge: async (id: string, method: string, payload?: unknown, context?: PiPluginWorkspace) =>
    (
      await http.post<{ data: { value?: unknown; events?: PiPluginEvent[] } }>(
        `${pluginURL(id)}/runtime/bridge`,
        { method, payload, context },
      )
    ).data.data,
  remove: async (id: string) => {
    await http.delete(pluginURL(id))
  },
}
