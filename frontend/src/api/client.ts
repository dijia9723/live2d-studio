import axios from 'axios'
import type {
  Character,
  Conversation,
  Message,
  SceneAsset,
  Settings,
  StreamEvent,
} from '../types/api'
import { SSEDecoder } from '../utils/sse'

export const baseURL =
  (window as Window & { __STUDIO_API_BASE_URL__?: string }).__STUDIO_API_BASE_URL__ ||
  (import.meta as ImportMeta & { env: Record<string, string> }).env.VITE_API_BASE_URL ||
  '/api/v1'
export const http = axios.create({ baseURL, headers: { 'X-Studio-Client': '1' }, timeout: 120000 })
export const mediaURL = (url: string) => new URL(url, new URL(baseURL, window.location.href)).href
http.interceptors.response.use(
  (r) => r,
  (error) =>
    Promise.reject(new Error(error.response?.data?.message || error.message || '连接服务失败')),
)
async function get<T>(path: string): Promise<T> {
  return (await http.get(path)).data.data
}
export const api = {
  sceneAssets: () => get<SceneAsset[]>('/scene-assets'),
  uploadSceneAsset: async (
    file: File,
    onProgress: (progress: number) => void,
  ): Promise<SceneAsset> => {
    const form = new FormData()
    form.append('file', file)
    return (
      await http.post('/scene-assets', form, {
        timeout: 600000,
        onUploadProgress: (event) =>
          onProgress(Math.round((event.loaded / (event.total || file.size)) * 100)),
      })
    ).data.data
  },
  deleteSceneAsset: (id: string) => http.delete(`/scene-assets/${id}`),
  characters: () => get<Character[]>('/characters'),
  saveCharacter: async (c: Character): Promise<Character> =>
    (await http.put(`/characters/${c.id}`, c)).data.data,
  importModel: async (file: File): Promise<Character> => {
    const form = new FormData()
    form.append('file', file)
    return (await http.post('/characters/import', form)).data.data
  },
  conversations: () => get<Conversation[]>('/conversations'),
  createConversation: async (character_id: string): Promise<Conversation> =>
    (await http.post('/conversations', { character_id })).data.data,
  deleteConversation: (id: string) => http.delete(`/conversations/${id}`),
  renameConversation: (id: string, title: string) => http.put(`/conversations/${id}`, { title }),
  messages: (id: string) => get<Message[]>(`/conversations/${id}/messages`),
  settings: () => get<Settings>('/settings'),
  saveSettings: async (
    s: Settings & { clear_llm_key?: boolean; clear_speech_key?: boolean },
  ): Promise<Settings> => (await http.put('/settings', s)).data.data,
  testConnection: () => http.post('/settings/test'),
  desktop: () => get<{ available: boolean }>('/desktop'),
  window: (action: 'pet' | 'pin', enabled: boolean) => http.post(`/desktop/${action}`, { enabled }),
  transcribe: async (blob: Blob): Promise<string> => {
    const f = new FormData()
    f.append('file', blob, 'recording.webm')
    return (await http.post('/speech/transcribe', f)).data.data.text
  },
  synthesize: async (text: string, signal: AbortSignal): Promise<Blob> =>
    (await http.post('/speech/synthesize', { text }, { responseType: 'blob', signal })).data,
}

export async function streamMessage(
  id: string,
  text: string,
  image: string | undefined,
  signal: AbortSignal,
  onEvent: (e: StreamEvent) => void,
) {
  const timeout = new AbortController()
  const cancel = () => timeout.abort(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    timeout.abort()
  }, 185_000)
  try {
    const response = await fetch(`${baseURL}/conversations/${id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Client': '1' },
      body: JSON.stringify({ text, image }),
      signal: timeout.signal,
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.message || '发送消息失败')
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream'))
      throw new Error('服务返回了非流式响应，请重启更新后的客户端')
    if (!response.body) throw new Error('当前环境不支持流式响应')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let doneEvent = false
    let streamError = ''
    const parser = new SSEDecoder((data) => {
      const event = JSON.parse(data) as StreamEvent
      if (event.type === 'done') doneEvent = true
      if (event.type === 'error') streamError = event.text || '模型请求失败'
      onEvent(event)
    })
    try {
      while (true) {
        const { value, done } = await reader.read()
        parser.push(decoder.decode(value, { stream: !done }))
        if (done) break
      }
      parser.finish()
      if (!doneEvent) throw new Error(streamError || '连接已中断，请重试')
    } finally {
      reader.releaseLock()
    }
  } catch (error) {
    if (timedOut) throw new Error('模型回复超时，请检查模型服务或稍后重试')
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
  }
}
