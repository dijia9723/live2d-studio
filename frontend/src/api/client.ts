/**
 * 文件职责：前端唯一的 HTTP 访问层。
 * 负责统一 baseURL、注入桌面客户端标识头、归一化错误信息、封装各类 REST 接口，
 * 以及处理聊天消息的 SSE 流式读取。
 */
import axios from 'axios'
import type {
  Character,
  CharacterActions,
  ActionNames,
  CharacterMemory,
  Conversation,
  Message,
  LLMProfile,
  LLMProvider,
  OllamaModel,
  SceneAsset,
  Settings,
  StreamEvent,
} from '../types/api'
import { SSEDecoder } from '../utils/sse'

/**
 * 接口根地址优先级：桌面端注入的全局变量 > Vite 环境变量 > 默认相对路径。
 * 桌面客户端会把本地服务地址写入 __STUDIO_API_BASE_URL__。
 */
export const baseURL =
  (window as Window & { __STUDIO_API_BASE_URL__?: string }).__STUDIO_API_BASE_URL__ ||
  (import.meta as ImportMeta & { env: Record<string, string> }).env.VITE_API_BASE_URL ||
  '/api/v1'
/** 全局 axios 实例；X-Studio-Client 让后端识别来自桌面/网页客户端的写操作。 */
export const http = axios.create({ baseURL, headers: { 'X-Studio-Client': '1' }, timeout: 120000 })
/** 把后端返回的相对资源路径解析为可直接用于 img/video 的绝对地址。 */
export const mediaURL = (url: string) => new URL(url, new URL(baseURL, window.location.href)).href
// 统一把后端返回的 message 提取为 Error.message，避免上层各处重复判断。
http.interceptors.response.use(
  (r) => r,
  (error) =>
    Promise.reject(new Error(error.response?.data?.message || error.message || '连接服务失败')),
)
/** 通用 GET 包裹：只取响应体中的 data 字段，并透传 AbortSignal 以便取消。 */
async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return (await http.get(path, { signal })).data.data
}
/** 全部后端接口的集合，按业务域分组（素材、角色、会话、设置、桌面、语音）。 */
export const api = {
  sceneAssets: () => get<SceneAsset[]>('/scene-assets'),
  // 上传背景/叠加素材，用 onUploadProgress 回传 0–100 的百分比。
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
  characterActions: (id: string, signal: AbortSignal) =>
    get<CharacterActions>(`/characters/${id}/actions`, signal),
  saveActionNames: async (
    id: string,
    model_path: string,
    action_names: ActionNames,
  ): Promise<Character> =>
    (await http.put(`/characters/${id}/action-names`, { model_path, action_names })).data.data,
  characterMemories: (id: string, signal: AbortSignal) =>
    get<CharacterMemory[]>(`/characters/${id}/memories`, signal),
  // 传入 memoryID 时更新已有记忆，否则新建；返回值统一为最新记忆对象。
  saveCharacterMemory: async (
    id: string,
    content: string,
    memoryID?: string,
  ): Promise<CharacterMemory> => {
    const path = `/characters/${id}/memories`
    const response = memoryID
      ? await http.put(`${path}/${memoryID}`, { content })
      : await http.post(path, { content })
    return response.data.data
  },
  deleteCharacterMemory: (id: string, memoryID: string) =>
    http.delete(`/characters/${id}/memories/${memoryID}`),
  saveCharacter: async (c: Character): Promise<Character> =>
    (await http.put(`/characters/${c.id}`, c)).data.data,
  // 导入 Live2D 模型 ZIP（含 model3.json 及其引用资源）。
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
  settings: (signal?: AbortSignal) => get<Settings>('/settings', signal),
  llmProfile: (provider: LLMProvider, signal: AbortSignal) =>
    get<LLMProfile>(`/settings/llm/${provider}`, signal),
  // clear_*_key 为 true 时表示用户主动要求清除已保存的密钥。
  saveSettings: async (
    s: Settings & { clear_llm_key?: boolean; clear_speech_key?: boolean },
  ): Promise<Settings> => (await http.put('/settings', s)).data.data,
  testConnection: () => http.post('/settings/test', undefined, { timeout: 150000 }),
  ollamaModels: async (base_url: string, signal: AbortSignal): Promise<OllamaModel[]> =>
    (await http.post('/settings/ollama/models', { base_url }, { signal, timeout: 12000 })).data.data
      .models,
  desktop: () => get<{ available: boolean }>('/desktop'),
  // 控制桌面端窗口行为：pet 开关桌宠窗口，pin 切换置顶。
  window: (action: 'pet' | 'pin', enabled: boolean) => http.post(`/desktop/${action}`, { enabled }),
  // 上传录音并返回转写文本。
  transcribe: async (blob: Blob): Promise<string> => {
    const f = new FormData()
    f.append('file', blob, 'recording.webm')
    return (await http.post('/speech/transcribe', f)).data.data.text
  },
  // 文本转语音，返回音频 Blob；支持 AbortSignal 以便打断播放。
  synthesize: async (text: string, signal: AbortSignal): Promise<Blob> =>
    (await http.post('/speech/synthesize', { text }, { responseType: 'blob', signal })).data,
}

/**
 * 发送消息并消费服务端 SSE 流。
 * @param id 会话 ID
 * @param text 文本内容
 * @param image 可选图片（data URL）
 * @param signal 外部取消信号，用于用户点击“停止”
 * @param onEvent 每个解析完成的事件回调
 * 超时（185 秒）与外部取消都会被转换为友好错误，且保证清理定时器与监听器。
 */
export async function streamMessage(
  id: string,
  text: string,
  image: string | undefined,
  signal: AbortSignal,
  onEvent: (e: StreamEvent) => void,
) {
  // 内部控制器同时受外部 signal 和超时定时器约束，任一触发都会中断请求。
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
    // 必须是 SSE，否则说明服务端版本过旧或经过了不支持流式的代理。
    if (!response.headers.get('content-type')?.includes('text/event-stream'))
      throw new Error('服务返回了非流式响应，请重启更新后的客户端')
    if (!response.body) throw new Error('当前环境不支持流式响应')
    const reader = response.body.getReader()
    // 流式解码：跨 chunk 的多字节字符由 TextDecoder 自行缓冲。
    const decoder = new TextDecoder()
    let doneEvent = false
    let streamError = ''
    const parser = new SSEDecoder((data) => {
      const event = JSON.parse(data) as StreamEvent
      // done 事件代表服务端已完成，用于区分“正常结束”和“连接被提前断开”。
      if (event.type === 'done' && event.message) doneEvent = true
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
      // 没有收到 done 视为中断，优先抛出服务端给出的错误信息。
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
