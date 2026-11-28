/**
 * 文件职责：编码工作台的编排接口。
 * 管理目标（Goal）、工作进程/子代理（Worker）、子代理定义及其审批、暂停、取消等操作。
 */
import { http } from './client'

/** 编排任务使用的模式，与编码模式保持一致。 */
export type OrchestrationMode = 'plan' | 'agent'
/** 一个可审批的执行目标；criteria 为验收标准，artifact 记录产出及其哈希。 */
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

/** 目标下执行的工作进程或子代理；accepted 表示结果是否被主会话采纳。 */
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

/** 当前会话的编排状态；active 为 true 时 worker 为正在进行的任务。 */
export interface CodingOrchestrationStatus {
  active: boolean
  worker: CodingWorker | null
}

/** 可配置的子代理定义；builtin 表示内置项，删除即恢复默认。 */
export interface CodingSubagent {
  name: string
  label: string
  instructions: string
  enabled: boolean
  builtin: boolean
  model_provider?: string
  model_name?: string
}

// 会话 ID 可能包含路径分隔符等字符，统一编码后再拼进 URL。
const sessionPath = (session: string) => `/coding/sessions/${encodeURIComponent(session)}`

/** 统一解包响应体的 data 字段，并透传 AbortSignal。 */
async function get<T>(path: string, signal?: AbortSignal) {
  return (await http.get<{ data: T }>(path, { signal })).data.data
}

/** 发送 POST 并解包 data；默认空对象避免后端要求 JSON 请求体。 */
async function post<T>(path: string, body: Record<string, unknown> = {}) {
  return (await http.post<{ data: T }>(path, body)).data.data
}

/** 编排相关的全部接口。 */
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
