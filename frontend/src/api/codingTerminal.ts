/**
 * 文件职责：编码工作台内嵌终端的接口。
 * 负责创建/关闭终端、发送按键、调整尺寸，并通过 SSE 增量读取输出。
 */
import { baseURL, http } from './client'
import { SSEDecoder } from '../utils/sse'

/** 终端的字符行列数，随面板尺寸变化。 */
export interface TerminalSize {
  cols: number
  rows: number
}

/** 终端输出流的事件；cursor 用于断线后从上次位置续传。 */
export type TerminalEvent =
  | { type: 'output'; data: string; cursor: number }
  | { type: 'reset'; cursor?: number }
  | { type: 'exit'; code: number }

// 项目与终端 ID 都可能含特殊字符，统一编码后拼接路径。
const route = (project: string, terminal?: string) =>
  `/coding/projects/${encodeURIComponent(project)}/terminals${terminal ? `/${encodeURIComponent(terminal)}` : ''}`

// 终端输入按原始字节传输，转成 base64 后放进 JSON 才不会破坏控制字符。
function toBase64(text: string) {
  const encoded = new TextEncoder().encode(text)
  return btoa(String.fromCharCode(...encoded))
}

/** 终端相关的全部接口。 */
export const codingTerminalAPI = {
  start: async (project: string, size: TerminalSize) =>
    (await http.post<{ data: { id: string } }>(route(project), size)).data.data,
  input: (project: string, terminal: string, data: string) =>
    http.post(`${route(project, terminal)}/input`, { data: toBase64(data) }),
  resize: (project: string, terminal: string, size: TerminalSize) =>
    http.put(`${route(project, terminal)}/size`, size),
  // keepalive 用于页面关闭/刷新时发送，普通请求会被浏览器直接取消。
  async stop(project: string, terminal: string, keepalive = false) {
    if (!keepalive) {
      await http.delete(route(project, terminal))
      return
    }
    await fetch(`${baseURL}${route(project, terminal)}`, {
      method: 'DELETE',
      headers: { 'X-Studio-Client': '1' },
      keepalive: true,
    })
  },
  /**
   * 连接终端输出流。
   * @param cursor 上次收到的输出位置，用于断线续传
   * @param onAttach 响应头返回后立即回调，供调用方重置终端缓冲
   */
  async stream(
    project: string,
    terminal: string,
    cursor: number,
    signal: AbortSignal,
    onAttach: () => void,
    onEvent: (event: TerminalEvent) => void,
  ) {
    const response = await fetch(`${baseURL}${route(project, terminal)}/events?cursor=${cursor}`, {
      headers: { 'X-Studio-Client': '1' },
      signal,
    })
    if (!response.ok || !response.body) {
      throw new Error(
        ((await response.json().catch(() => null)) as { message?: string } | null)?.message ||
          '终端输出连接失败',
      )
    }
    onAttach()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const parser = new SSEDecoder((data) => onEvent(JSON.parse(data) as TerminalEvent))
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
  },
}
