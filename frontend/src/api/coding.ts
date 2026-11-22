import { baseURL, http } from './client'
import { SSEDecoder } from '../utils/sse'

export interface CodingProject {
  id: string
  name: string
  path: string
}
export interface CodingSession {
  id: string
  project_id: string
  title: string
  archived: boolean
  updated_at: string
}
export interface CodingMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  status: 'complete' | 'streaming' | 'interrupted' | 'failed'
  error?: string
  tools?: CodingToolRun[]
}
export interface CodingToolRun {
  name: string
  path: string
}
export interface CodingFile {
  content: string
  revision: string
}
export interface FileEntry {
  name: string
  dir: boolean
}
export interface CodingChanges {
  available: boolean
  status: string
  diff: string
}
export type CodingMode = 'plan' | 'agent'
export interface CodingEnhancements {
  titles: boolean
  model_titles: boolean
  suggestions: boolean
  rewrite: boolean
  recall: boolean
  memory_write: boolean
}
export interface CodingMemory {
  id: string
  project_id: string
  content: string
}
export interface CodingSQLitePage {
  tables: string[]
  table: string
  columns: string[]
  rows: (string | null)[][]
  page: number
  page_size: number
  has_more: boolean
  tables_truncated: boolean
  columns_truncated: boolean
  stale_wal: boolean
}
export type CodingEvent =
  | { type: 'started'; title: string }
  | { type: 'delta' | 'error'; text: string }
  | { type: 'tool'; name: string; path: string }
  | { type: 'changed'; path: string }
  | { type: 'done'; message: CodingMessage }

const projectPath = (id: string) => `/coding/projects/${id}`
const sessionPath = (id: string) => `/coding/sessions/${id}`

async function get<T>(path: string, signal?: AbortSignal, params?: Record<string, string>) {
  return (await http.get<{ data: T }>(path, { signal, params })).data.data
}

export const codingAPI = {
  runtime: (signal?: AbortSignal) =>
    get<{ ready: boolean; message?: string }>('/coding/runtime', signal),
  enhancements: (signal?: AbortSignal) => get<CodingEnhancements>('/coding/enhancements', signal),
  saveEnhancements: async (settings: CodingEnhancements) =>
    (await http.put<{ data: CodingEnhancements }>('/coding/enhancements', settings)).data.data,
  rewrite: async (text: string, signal?: AbortSignal) =>
    (
      await http.post<{ data: { text: string } }>(
        '/coding/enhancements/rewrite',
        { text },
        { signal },
      )
    ).data.data.text,
  suggestion: async (id: string, signal?: AbortSignal) =>
    (await http.post<{ data: { text: string } }>(`${sessionPath(id)}/suggestion`, {}, { signal }))
      .data.data.text,
  memories: (project: string, signal?: AbortSignal) =>
    get<CodingMemory[]>('/coding/enhancements/memory', signal, { project }),
  saveMemory: async (content: string, project: string, id?: string) =>
    (
      await http.post<{ data: CodingMemory }>('/coding/enhancements/memory', {
        id,
        content,
        project_id: project,
      })
    ).data.data,
  removeMemory: (id: string) => http.delete(`/coding/enhancements/memory/${id}`),
  projects: (signal?: AbortSignal) => get<CodingProject[]>('/coding/projects', signal),
  addProject: async (path: string) =>
    (await http.post<{ data: CodingProject }>('/coding/projects', { path })).data.data,
  pickDirectory: async () =>
    (await http.post<{ data: { path: string } }>('/coding/pick-directory', {}, { timeout: 0 })).data
      .data.path,
  sessions: (project: string, signal?: AbortSignal) =>
    get<CodingSession[]>(`${projectPath(project)}/sessions`, signal),
  newSession: async (project: string) =>
    (await http.post<{ data: CodingSession }>(`${projectPath(project)}/sessions`, {})).data.data,
  updateSession: async (session: string, update: { title?: string; archived?: boolean }) =>
    (await http.put<{ data: CodingSession }>(sessionPath(session), update)).data.data,
  forkSession: async (session: string) =>
    (await http.post<{ data: CodingSession }>(`${sessionPath(session)}/fork`, {})).data.data,
  messages: (session: string, signal?: AbortSignal) =>
    get<CodingMessage[]>(`${sessionPath(session)}/messages`, signal),
  files: (project: string, path: string, signal?: AbortSignal) =>
    get<FileEntry[]>(`${projectPath(project)}/files`, signal, { path }),
  search: (project: string, q: string, signal?: AbortSignal) =>
    get<{ files: string[]; truncated: boolean }>(`${projectPath(project)}/search`, signal, { q }),
  file: (project: string, path: string, signal?: AbortSignal) =>
    get<CodingFile>(`${projectPath(project)}/file`, signal, { path }),
  sqlite: (project: string, path: string, table: string, page: number, signal: AbortSignal) =>
    get<CodingSQLitePage>(`${projectPath(project)}/sqlite`, signal, {
      path,
      table,
      page: String(page),
    }),
  media: async (project: string, path: string, signal: AbortSignal) =>
    (
      await http.get<Blob>(`${projectPath(project)}/preview`, {
        params: { path },
        signal,
        responseType: 'blob',
      })
    ).data,
  fileAction: (
    project: string,
    action: 'file' | 'directory' | 'move' | 'remove',
    path: string,
    target?: string,
  ) => http.post(`${projectPath(project)}/files/action`, { action, path, target }),
  saveFile: async (project: string, path: string, file: CodingFile) =>
    (await http.put<{ data: CodingFile }>(`${projectPath(project)}/file`, { path, ...file })).data
      .data,
  changes: (project: string, signal?: AbortSignal) =>
    get<CodingChanges>(`${projectPath(project)}/changes`, signal),
  stop: (session: string) => http.post(`${sessionPath(session)}/stop`, {}),
}

export async function streamCoding(
  session: string,
  text: string,
  mode: CodingMode,
  signal: AbortSignal,
  onEvent: (event: CodingEvent) => void,
) {
  const response = await fetch(`${baseURL}${sessionPath(session)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio-Client': '1' },
    body: JSON.stringify({ text, mode }),
    signal,
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.message || '启动编码会话失败')
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('编码服务返回了非流式响应')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let final: CodingMessage | undefined
  let error = ''
  const parser = new SSEDecoder((data) => {
    const event = JSON.parse(data) as CodingEvent
    if (event.type === 'done') final = event.message
    if (event.type === 'error') error = event.text
    onEvent(event)
  })
  try {
    while (true) {
      const { value, done } = await reader.read()
      parser.push(decoder.decode(value, { stream: !done }))
      if (done) break
    }
    parser.finish()
  } finally {
    reader.releaseLock()
  }
  if (!final) throw new Error(error || '编码会话连接已中断')
  return final
}
