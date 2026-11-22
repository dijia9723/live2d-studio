import { http } from './client'

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

export interface PiPlugin extends PluginMetadata {
  source: 'bundled' | 'local' | 'marketplace'
  enabled: boolean
  supported: string[]
  installed_at?: string
  error?: string
  host_granted?: boolean
}

export interface PiMarketplacePlugin extends PluginMetadata {
  versions: string[]
  categories?: string[]
  verified?: boolean
  readme_markdown?: string
}

export interface PiPluginTheme {
  id: string
  plugin_id: string
  label: string
  base: 'light' | 'dark'
  tokens: Record<string, string>
}

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

export interface PiHostSetting {
  key: string
  type: string
  title: string
  description?: string
  default?: unknown
  options?: (string | { value: string; label?: string })[]
}

export interface PiHostPlugin {
  id: string
  name: string
  commands?: { id: string; title: string }[]
  views?: { id: string; title: string; kind: 'panel' | 'view' }[]
  settings?: PiHostSetting[]
}

export interface PiPluginEvent {
  type: 'toast' | 'panel'
  text?: string
  id?: string
  title?: string
}

export interface PiPluginWorkspace {
  project_id: string
  session_id?: string
}

export interface PiTrustedExtension {
  version: string
  entries: string[]
  approved: boolean
  ready: boolean
}

const endpoint = '/coding/plugins'
const pluginURL = (id: string) => `${endpoint}/${encodeURIComponent(id)}`

async function list<T>(path: string, signal?: AbortSignal) {
  return (await http.get<{ data: T[] }>(path, { signal })).data.data
}

export const piPluginsAPI = {
  themes: (signal?: AbortSignal) => list<PiPluginTheme>(`${endpoint}/themes`, signal),
  list: (signal?: AbortSignal) => list<PiPlugin>(endpoint, signal),
  marketplace: (signal?: AbortSignal) =>
    list<PiMarketplacePlugin>(`${endpoint}/marketplace`, signal),
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
