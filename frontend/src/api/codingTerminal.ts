import { baseURL, http } from './client'
import { SSEDecoder } from '../utils/sse'

export interface TerminalSize {
  cols: number
  rows: number
}

export type TerminalEvent =
  | { type: 'output'; data: string; cursor: number }
  | { type: 'reset'; cursor?: number }
  | { type: 'exit'; code: number }

const route = (project: string, terminal?: string) =>
  `/coding/projects/${encodeURIComponent(project)}/terminals${terminal ? `/${encodeURIComponent(terminal)}` : ''}`

function toBase64(text: string) {
  const encoded = new TextEncoder().encode(text)
  return btoa(String.fromCharCode(...encoded))
}

export const codingTerminalAPI = {
  start: async (project: string, size: TerminalSize) =>
    (await http.post<{ data: { id: string } }>(route(project), size)).data.data,
  input: (project: string, terminal: string, data: string) =>
    http.post(`${route(project, terminal)}/input`, { data: toBase64(data) }),
  resize: (project: string, terminal: string, size: TerminalSize) =>
    http.put(`${route(project, terminal)}/size`, size),
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
