/**
 * 文件职责：编码（Coding）工作台的 REST 接口与消息流客户端。
 * 覆盖项目、会话、消息、文件浏览、SQLite 预览与增强能力；消息生成通过 SSE
 * 逐条回传 started / delta / tool / changed / done 事件。
 */
import { baseURL, http } from './client'
import { SSEDecoder } from '../utils/sse'

/** 用户纳管的本地代码项目；path 为后端可访问的绝对路径。 */
export interface CodingProject {
  id: string
  name: string
  path: string
}
/** 项目下的一个编码会话；archived 表示已归档。 */
export interface CodingSession {
  id: string
  project_id: string
  title: string
  archived: boolean
  updated_at: string
}
/** 一条用户或助手消息；status 表示流式生成结果，失败时 error 携带原因。 */
export interface CodingMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  status: 'complete' | 'streaming' | 'interrupted' | 'failed'
  error?: string
  tools?: CodingToolRun[]
}
/** 助手调用一次工具的记录；path 为相对项目根目录的路径。 */
export interface CodingToolRun {
  name: string
  path: string
}
/** 文件内容与版本标记；保存时回传 revision 供后端校验并发覆盖。 */
export interface CodingFile {
  content: string
  revision: string
}
/** 文件树中的一个节点；dir 为 true 时表示目录。 */
export interface FileEntry {
  name: string
  dir: boolean
}
/** 项目的 Git 变更概览；available 为 false 时 diff 不可用。 */
export interface CodingChanges {
  available: boolean
  status: string
  diff: string
}
/** 编码模式：plan 只做只读规划，agent 允许直接改动文件。 */
export type CodingMode = 'plan' | 'agent'
/** 编码增强功能开关，均由用户在设置中显式开启。 */
export interface CodingEnhancements {
  titles: boolean
  model_titles: boolean
  suggestions: boolean
  rewrite: boolean
  recall: boolean
  memory_write: boolean
}
/** 项目级记忆条目，随编码对话长期提供上下文。 */
export interface CodingMemory {
  id: string
  project_id: string
  content: string
}
/** SQLite 表分页结果；*_truncated 表示列表被截断，stale_wal 表示读到了旧的 WAL 数据。 */
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
/** 编码消息流的 SSE 事件；done 事件携带最终完整消息。 */
export type CodingEvent =
  | { type: 'started'; title: string }
  | { type: 'delta' | 'error'; text: string }
  | { type: 'tool'; name: string; path: string }
  | { type: 'changed'; path: string }
  | { type: 'done'; message: CodingMessage }

// 项目与会话的资源路径集中拼接，避免调用方手写重复前缀。
const projectPath = (id: string) => `/coding/projects/${id}`
const sessionPath = (id: string) => `/coding/sessions/${id}`

/** 统一解包响应体的 data 字段，并透传 AbortSignal 以便请求可被取消。 */
async function get<T>(path: string, signal?: AbortSignal, params?: Record<string, string>) {
  return (await http.get<{ data: T }>(path, { signal, params })).data.data
}

/** 编码工作台的全部接口，按项目、会话、文件与增强能力分组。 */
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
  // 系统目录选择框会一直等待用户操作，因此禁用 axios 的默认超时。
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
  // 预览图片/音视频按二进制返回，避免被当成 JSON 解析。
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

/**
 * 发送一条编码消息并消费 SSE 事件流。
 * 以 done 事件的完整消息作为最终结果；连接若提前结束，优先抛出错误事件中的文本，
 * 否则给出通用中断提示，避免调用方拿到不完整结果。
 * @param onEvent 每收到一条事件都会回调，用于增量渲染
 * @returns 最终完成的助手消息
 */
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
  // 没有收到 done 事件说明流被中途截断，不能用半截内容当作成功结果。
  if (!final) throw new Error(error || '编码会话连接已中断')
  return final
}
