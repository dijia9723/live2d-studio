/**
 * 文件职责：抖音直播陪伴功能的接口与类型。
 * 包含直播配置、实时状态轮询、互动事件/回复，以及历史场次与 AI 复盘。
 */
import { http } from './client'
import type { StageAction } from '../types/api'

/** 支持的直播互动类型：弹幕、礼物、点赞、进场、关注。 */
export const liveKinds = ['chat', 'gift', 'like', 'enter', 'follow'] as const
export type LiveKind = (typeof liveKinds)[number]
/** 互动模式：manual 手动回应、auto 自动回应、paused 暂停 AI。 */
export type LiveMode = 'manual' | 'auto' | 'paused'

/** 直播监听配置；events/reply_events 为 null 表示不限制类型。 */
export interface LiveConfig {
  room: string
  character_id: string
  prompt: string
  temperature: number
  poll_seconds: number
  reply_seconds: number
  batch_size: number
  max_tokens: number
  mode: LiveMode
  events: LiveKind[] | null
  reply_events: LiveKind[] | null
  speak: boolean
  actions: boolean
}

/** 一条直播互动事件；礼物/点赞的 count 为数量，弹幕的 text 为内容。 */
export interface LiveEvent {
  id: number
  kind: LiveKind
  viewer: string
  text?: string
  count: number
  at: string
}

/** 一条 AI 回应；stage/expression 为经后端校验的角色动作与表情请求。 */
export interface LiveReply {
  id: number
  text?: string
  error?: string
  at: string
  event_ids: number[]
  stage?: StageAction[]
  expression?: string
}

/** 直播运行态快照；phase 描述连接阶段，counts/events/replies 可能被后端裁剪。 */
export interface LiveState {
  config: LiveConfig
  session_id: string
  running: boolean
  busy: boolean
  title?: string
  phase: 'stopped' | 'checking' | 'waiting' | 'connecting' | 'live' | 'retrying'
  error?: string
  counts: Partial<Record<LiveKind, number>> | null
  events: LiveEvent[] | null
  replies: LiveReply[] | null
  pending: number
  auto_ready: boolean
  draft?: string
  recording_id?: string
  archive_error?: string
}

/** 一场历史直播记录；incomplete 表示监听过程中断、数据可能不全。 */
export interface LiveSession {
  id: string
  room: string
  title: string
  character_name: string
  started_at: string
  ended_at?: string
  status: 'recording' | 'ended' | 'interrupted'
  incomplete: boolean
}

/** 历史场次的互动汇总与 AI 复盘。 */
export interface LiveSessionDetails extends LiveSession {
  counts: Partial<Record<LiveKind, number>>
  reply_count: number
  failed_replies: number
  gifts: { name: string; count: number }[]
  summary?: string
}

/** 直播相关的全部接口。 */
export const liveAPI = {
  async state(signal: AbortSignal): Promise<LiveState> {
    return (await http.get('/live/state', { signal })).data.data
  },
  async save(config: LiveConfig): Promise<LiveState> {
    return (await http.put('/live/config', config)).data.data
  },
  async start(): Promise<LiveState> {
    return (await http.post('/live/start')).data.data
  },
  async stop(): Promise<LiveState> {
    return (await http.post('/live/stop')).data.data
  },
  async sessions(page: number, signal: AbortSignal): Promise<{ sessions: LiveSession[]; has_more: boolean }> {
    return (await http.get('/live/sessions', { params: { page }, signal })).data.data
  },
  async session(id: string, signal: AbortSignal): Promise<LiveSessionDetails> {
    return (await http.get(`/live/sessions/${id}`, { signal })).data.data
  },
  // 生成复盘会修改后端数据，因此用 POST 而非 GET。
  async summarize(id: string, signal: AbortSignal): Promise<LiveSessionDetails> {
    return (await http.post(`/live/sessions/${id}/summary`, undefined, { signal })).data.data
  },
  // event_id 为 0 表示不针对单条事件，让后端汇总当前待回应的互动。
  async reply(session: string, event?: number): Promise<{ accepted: boolean; state: LiveState }> {
    return (await http.post('/live/reply', { session_id: session, event_id: event || 0 })).data.data
  },
}
