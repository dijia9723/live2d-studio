import { http } from './client'
import type { StageAction } from '../types/api'

export const liveKinds = ['chat', 'gift', 'like', 'enter', 'follow'] as const
export type LiveKind = (typeof liveKinds)[number]
export type LiveMode = 'manual' | 'auto' | 'paused'

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

export interface LiveEvent {
  id: number
  kind: LiveKind
  viewer: string
  text?: string
  count: number
  at: string
}

export interface LiveReply {
  id: number
  text?: string
  error?: string
  at: string
  event_ids: number[]
  stage?: StageAction[]
  expression?: string
}

export interface LiveState {
  config: LiveConfig
  session_id: string
  running: boolean
  demo: boolean
  busy: boolean
  title?: string
  phase: 'stopped' | 'checking' | 'waiting' | 'connecting' | 'live' | 'retrying' | 'demo'
  error?: string
  counts: Partial<Record<LiveKind, number>> | null
  events: LiveEvent[] | null
  replies: LiveReply[] | null
  pending: number
  auto_ready: boolean
  draft?: string
}

export const liveAPI = {
  async state(signal: AbortSignal): Promise<LiveState> {
    return (await http.get('/live/state', { signal })).data.data
  },
  async save(config: LiveConfig): Promise<LiveState> {
    return (await http.put('/live/config', config)).data.data
  },
  async start(demo: boolean): Promise<LiveState> {
    return (await http.post('/live/start', { demo })).data.data
  },
  async stop(): Promise<LiveState> {
    return (await http.post('/live/stop')).data.data
  },
  async reply(session: string, event?: number): Promise<{ accepted: boolean; state: LiveState }> {
    return (await http.post('/live/reply', { session_id: session, event_id: event || 0 })).data.data
  },
  async demoEvent(kind: LiveKind): Promise<LiveState> {
    return (await http.post('/live/demo-event', { kind })).data.data
  },
}
