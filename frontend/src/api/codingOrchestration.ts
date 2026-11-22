import { http } from './client'

export type OrchestrationMode = 'plan' | 'agent'
export interface CodingGoal {
  id: string
  title: string
  objective: string
  criteria: { text: string; state: 'pending' | 'passed' | 'failed'; evidence?: string }[]
  status:
    | 'awaiting_approval'
    | 'running'
    | 'completed'
    | 'paused'
    | 'cancelled'
    | 'interrupted'
    | 'failed'
    | 'rejected'
    | 'blocked'
    | 'superseded'
  mode: OrchestrationMode
  rounds: number
  summary?: string
  error?: string
  artifact: string
  artifact_hash: string
}

export interface CodingWorker {
  id: string
  parent_id: string
  kind: 'worker' | 'subagent'
  role: string
  mode: OrchestrationMode
  task: string
  status: 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed'
  result?: string
  error?: string
  turns: number
  accepted: boolean
  model_provider?: string
  model_name?: string
}

export interface CodingOrchestrationStatus {
  active: boolean
  worker: CodingWorker | null
}

export interface CodingSubagent {
  name: string
  label: string
  instructions: string
  enabled: boolean
  builtin: boolean
  model_provider?: string
  model_name?: string
}

const sessionPath = (session: string) => `/coding/sessions/${encodeURIComponent(session)}`

async function get<T>(path: string, signal?: AbortSignal) {
  return (await http.get<{ data: T }>(path, { signal })).data.data
}

async function post<T>(path: string, body: Record<string, unknown> = {}) {
  return (await http.post<{ data: T }>(path, body)).data.data
}

export const orchestrationAPI = {
  status: (session: string, signal?: AbortSignal) =>
    get<CodingOrchestrationStatus>(`${sessionPath(session)}/orchestration-status`, signal),
  goals: (session: string, signal?: AbortSignal) =>
    get<CodingGoal[]>(`${sessionPath(session)}/goals`, signal),
  createGoal: (session: string, title: string, objective: string, criteria: string[]) =>
    post<CodingGoal>(`${sessionPath(session)}/goals`, { title, objective, criteria }),
  goalAction: (
    session: string,
    goal: string,
    action: 'approve' | 'reject' | 'pause' | 'resume' | 'cancel',
    mode?: OrchestrationMode,
    note?: string,
  ) => post<CodingGoal>(`${sessionPath(session)}/goals/${goal}/${action}`, { mode, note }),
  workers: (session: string, signal?: AbortSignal) =>
    get<CodingWorker[]>(`${sessionPath(session)}/workers`, signal),
  createWorker: (
    session: string,
    role: string,
    mode: OrchestrationMode,
    task: string,
    model: { model_provider: string; model_name: string },
  ) => post<CodingWorker>(`${sessionPath(session)}/workers`, { role, mode, task, ...model }),
  workerAction: (
    session: string,
    worker: string,
    action: 'send' | 'cancel' | 'accept',
    task?: string,
  ) => post<CodingWorker>(`${sessionPath(session)}/workers/${worker}/${action}`, { task }),
  subagents: (signal?: AbortSignal) => get<CodingSubagent[]>('/coding/subagents', signal),
  saveSubagent: async (agent: CodingSubagent) =>
    (
      await http.put<{ data: CodingSubagent }>(
        `/coding/subagents/${encodeURIComponent(agent.name)}`,
        agent,
      )
    ).data.data,
  resetSubagent: (name: string) => http.delete(`/coding/subagents/${encodeURIComponent(name)}`),
}
