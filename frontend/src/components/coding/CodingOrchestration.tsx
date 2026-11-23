import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Flag, RefreshCw, UsersRound } from 'lucide-react'
import type { CodingSession } from '../../api/coding'
import {
  orchestrationAPI,
  type CodingGoal,
  type CodingOrchestrationStatus,
  type CodingSubagent,
  type CodingWorker,
  type OrchestrationMode,
} from '../../api/codingOrchestration'
import CodingSubagentSettings from './CodingSubagentSettings'
import { CodingModelFields, type ModelSelection } from './CodingSessionModel'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { Textarea } from '../ui/textarea'
import '../../assets/coding-orchestration.css'

const statuses: Record<CodingGoal['status'], string> = {
  awaiting_approval: '等待审批',
  running: '执行中',
  completed: '已完成',
  paused: '已暂停',
  interrupted: '已中断',
  failed: '执行失败',
  rejected: '已拒绝',
  cancelled: '已取消',
  blocked: '等待补充',
  superseded: '已有新提案',
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : '编码编排操作失败'
}

function RunMode({
  value,
  disabled,
  onChange,
}: {
  value: OrchestrationMode
  disabled?: boolean
  onChange: (mode: OrchestrationMode) => void
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(mode) => onChange(mode as OrchestrationMode)}
    >
      <SelectTrigger aria-label="运行权限">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="plan">只读核查</SelectItem>
        <SelectItem value="agent">允许编辑项目文件</SelectItem>
      </SelectContent>
    </Select>
  )
}

interface Props {
  session: CodingSession
  busy?: boolean
  onOpenSession: (id: string) => void
  onSettled?: () => void
  onBusyChange?: (busy: boolean) => void
}

export default function CodingOrchestration({
  session,
  busy,
  onOpenSession,
  onSettled,
  onBusyChange,
}: Props) {
  const [panel, setPanel] = useState<'goal' | 'team' | ''>('')
  const [goals, setGoals] = useState<CodingGoal[]>([])
  const [workers, setWorkers] = useState<CodingWorker[]>([])
  const [activity, setActivity] = useState<CodingOrchestrationStatus>()
  const [goalID, setGoalID] = useState('')
  const [goalForm, setGoalForm] = useState(false)
  const [title, setTitle] = useState('')
  const [objective, setObjective] = useState('')
  const [criteria, setCriteria] = useState('')
  const [approvalMode, setApprovalMode] = useState<OrchestrationMode>('plan')
  const [resumeNote, setResumeNote] = useState('')
  const [role, setRole] = useState('worker')
  const [subagents, setSubagents] = useState<CodingSubagent[]>([])
  const [workerMode, setWorkerMode] = useState<OrchestrationMode>('plan')
  const [workerModel, setWorkerModel] = useState<ModelSelection>({
    model_provider: '',
    model_name: '',
  })
  const [task, setTask] = useState('')
  const [followUpID, setFollowUpID] = useState('')
  const [followUp, setFollowUp] = useState('')
  const [action, setAction] = useState(false)
  const [error, setError] = useState('')
  const workerSession = activity?.worker
  const running = !!activity?.active || goals.some((goal) => goal.status === 'running')
  const workerCount = workers.filter((worker) => worker.status === 'running').length
  const goal = goals.find((item) => item.id === goalID) || goals[0]
  const canResume = goal && ['paused', 'blocked', 'interrupted', 'failed'].includes(goal.status)
  const roleLabel = (name: string) =>
    name === 'worker' ? '工作会话' : (subagents.find((item) => item.name === name)?.label ?? name)
  const goalRecords = useRef<CodingGoal[]>([])
  const workerRecords = useRef<CodingWorker[]>([])
  const activeRecord = useRef(false)
  const request = useRef<AbortController>(null)
  const settled = useRef(onSettled)
  settled.current = onSettled
  const busyChange = useRef(onBusyChange)
  busyChange.current = onBusyChange

  const updateGoal = (value: CodingGoal) => {
    const list = [value, ...goalRecords.current.filter((item) => item.id !== value.id)]
    goalRecords.current = list
    setGoals(list)
  }
  const updateWorker = (value: CodingWorker) => {
    const list = [value, ...workerRecords.current.filter((item) => item.id !== value.id)]
    workerRecords.current = list
    setWorkers(list)
  }

  const refresh = async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    try {
      const [nextGoals, nextWorkers, nextActivity] = await Promise.all([
        orchestrationAPI.goals(session.id, controller.signal),
        orchestrationAPI.workers(session.id, controller.signal),
        orchestrationAPI.status(session.id, controller.signal),
      ])
      if (controller.signal.aborted) return
      const finished =
        (activeRecord.current && !nextActivity.active) ||
        nextGoals.some(
          (value) =>
            value.status !== 'running' &&
            goalRecords.current.some((old) => old.id === value.id && old.status === 'running'),
        ) ||
        nextWorkers.some(
          (value) =>
            value.status !== 'running' &&
            workerRecords.current.some((old) => old.id === value.id && old.status === 'running'),
        )
      goalRecords.current = nextGoals
      workerRecords.current = nextWorkers
      activeRecord.current = nextActivity.active
      setGoals(nextGoals)
      setWorkers(nextWorkers)
      setActivity(nextActivity)
      if (finished) settled.current?.()
    } catch (cause) {
      if (!controller.signal.aborted && panel) setError(errorMessage(cause))
    } finally {
      if (request.current === controller) request.current = null
    }
  }

  useEffect(() => {
    void refresh()
    return () => request.current?.abort()
  }, [session.id, busy])

  const updateSubagents = (items: CodingSubagent[]) => {
    setSubagents(items)
    setRole((current) =>
      current === 'worker' || items.some((item) => item.enabled && item.name === current)
        ? current
        : 'worker',
    )
  }

  useEffect(() => {
    if (panel !== 'team') return
    const controller = new AbortController()
    orchestrationAPI
      .subagents(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) updateSubagents(items)
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause))
      })
    return () => controller.abort()
  }, [panel])

  useEffect(() => {
    if (!running && !workerCount && !busy) return
    const timer = window.setInterval(() => {
      if (!request.current) void refresh()
    }, 1500)
    return () => window.clearInterval(timer)
  }, [session.id, running, workerCount, busy])

  useEffect(() => {
    busyChange.current?.(running)
    return () => busyChange.current?.(false)
  }, [running])

  const perform = async (work: () => Promise<void>) => {
    if (action) return
    request.current?.abort()
    setAction(true)
    setError('')
    try {
      await work()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setAction(false)
    }
  }

  const goalAction = (type: 'approve' | 'reject' | 'pause' | 'resume' | 'cancel') => {
    if (!goal) return
    void perform(async () => {
      const updated = await orchestrationAPI.goalAction(
        session.id,
        goal.id,
        type,
        type === 'approve' ? approvalMode : undefined,
        type === 'resume' ? resumeNote : undefined,
      )
      updateGoal(updated)
      setResumeNote('')
      if (type === 'pause' || type === 'cancel') void refresh()
    })
  }

  const togglePanel = (key: 'goal' | 'team') => {
    setError('')
    setPanel(panel === key ? '' : key)
    if (panel !== key) void refresh()
  }

  if (workerSession) {
    return (
      <div className="coding-orchestration">
        <header className="coding-actions">
          <UsersRound size={15} />
          <small>
            {roleLabel(workerSession.role)} · {statuses[workerSession.status]}
          </small>
          <button
            type="button"
            className="coding-button"
            onClick={() => onOpenSession(workerSession.parent_id)}
          >
            返回父会话
          </button>
          {workerSession.status === 'running' && (
            <button
              type="button"
              className="coding-button"
              disabled={action}
              onClick={() => {
                void perform(async () => {
                  await orchestrationAPI.workerAction(
                    workerSession.parent_id,
                    workerSession.id,
                    'cancel',
                  )
                  void refresh()
                })
              }}
            >
              停止工作会话
            </button>
          )}
        </header>
        {error && (
          <p className="coding-alert" role="alert">
            {error}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="coding-orchestration">
      <header className="coding-actions">
        <button
          type="button"
          className="coding-button"
          aria-expanded={panel === 'goal'}
          onClick={() => togglePanel('goal')}
        >
          <Flag size={14} />
          Goal{goal ? <small>{statuses[goal.status]}</small> : null}
          <ChevronDown size={13} />
        </button>
        <button
          type="button"
          className="coding-button"
          aria-expanded={panel === 'team'}
          onClick={() => togglePanel('team')}
        >
          <UsersRound size={15} />
          编排{workerCount > 0 ? <small>{workerCount} 正在执行</small> : null}
          <ChevronDown size={13} />
        </button>
        {panel && (
          <button
            type="button"
            className="coding-icon"
            aria-label="刷新编排状态"
            onClick={() => void refresh()}
          >
            <RefreshCw size={15} />
          </button>
        )}
      </header>
      {panel && error && (
        <p className="coding-alert" role="alert">
          {error}
        </p>
      )}
      {panel === 'goal' && (
        <section className="coding-orchestration-body" aria-label="目标与验收">
          <div className="coding-actions">
            {goals.length > 0 && (
              <Select
                value={goal?.id ?? ''}
                onValueChange={(id) => {
                  setGoalID(id)
                  setApprovalMode('plan')
                  setResumeNote('')
                }}
              >
                <SelectTrigger aria-label="目标历史">
                  <SelectValue placeholder="目标历史" />
                </SelectTrigger>
                <SelectContent>
                  {goals.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.title} · {statuses[item.status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <button
              type="button"
              className="coding-button"
              disabled={action || running}
              onClick={() => setGoalForm(!goalForm)}
            >
              {goalForm ? '收起提案编辑' : '新目标'}
            </button>
          </div>
          {goalForm && (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                const items = criteria
                  .split(/\r?\n/)
                  .map((line) => line.trim())
                  .filter(Boolean)
                void perform(async () => {
                  const value = await orchestrationAPI.createGoal(
                    session.id,
                    title,
                    objective,
                    items,
                  )
                  updateGoal(value)
                  setGoalID(value.id)
                  setTitle('')
                  setObjective('')
                  setCriteria('')
                  setApprovalMode('plan')
                  setGoalForm(false)
                  void refresh()
                })
              }}
            >
              <label>
                目标名称
                <input
                  maxLength={100}
                  required
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label>
                目标说明
                <Textarea
                  rows={3}
                  maxLength={12000}
                  required
                  value={objective}
                  onChange={(event) => setObjective(event.target.value)}
                />
              </label>
              <label>
                验收条件（每行一条）
                <Textarea
                  rows={3}
                  maxLength={6020}
                  required
                  value={criteria}
                  onChange={(event) => setCriteria(event.target.value)}
                />
              </label>
              <button
                className="coding-button coding-primary"
                disabled={action || !title.trim() || !objective.trim() || !criteria.trim()}
              >
                保存提案
              </button>
            </form>
          )}
          {!goal && !goalForm && (
            <p className="coding-muted">定义目标和验收条件，批准后 Pi 会逐轮执行并记录证据。</p>
          )}
          {goal && (
            <article className="coding-orchestration-record">
              <h3>
                {goal.title}
                <small>
                  {statuses[goal.status]}
                  {goal.rounds > 0 && ` · 第 ${goal.rounds} 轮`}
                </small>
              </h3>
              <p>{goal.objective}</p>
              <ol className="coding-goal-criteria">
                {goal.criteria.map((item) => (
                  <li key={item.text} data-state={item.state}>
                    <span>{item.text}</span>
                    <small>
                      {item.state === 'passed'
                        ? '通过'
                        : item.state === 'failed'
                          ? '未通过'
                          : '待核验'}
                    </small>
                    {item.evidence && <p>{item.evidence}</p>}
                  </li>
                ))}
              </ol>
              {goal.summary && <p>{goal.summary}</p>}
              {goal.error && (
                <p className="coding-muted" role="status">
                  {goal.error}
                </p>
              )}
              <p className="coding-orchestration-path" title={goal.artifact_hash}>
                {goal.artifact}
              </p>
              {goal.status === 'awaiting_approval' && (
                <div className="coding-actions">
                  <RunMode
                    value={approvalMode}
                    onChange={setApprovalMode}
                    disabled={action || busy}
                  />
                  <button
                    type="button"
                    className="coding-button coding-primary"
                    disabled={action || busy}
                    onClick={() => goalAction('approve')}
                  >
                    批准并运行
                  </button>
                  <button
                    type="button"
                    className="coding-button"
                    disabled={action}
                    onClick={() => goalAction('reject')}
                  >
                    拒绝
                  </button>
                </div>
              )}
              {canResume && (
                <input
                  aria-label="继续目标的补充说明"
                  placeholder="补充说明（可选）"
                  maxLength={2000}
                  value={resumeNote}
                  onChange={(event) => setResumeNote(event.target.value)}
                />
              )}
              {(goal.status === 'running' || canResume) && (
                <div className="coding-actions">
                  {goal.status === 'running' ? (
                    <button
                      type="button"
                      className="coding-button"
                      disabled={action}
                      onClick={() => goalAction('pause')}
                    >
                      暂停
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="coding-button coding-primary"
                      disabled={action || busy}
                      onClick={() => goalAction('resume')}
                    >
                      继续
                    </button>
                  )}
                  <button
                    type="button"
                    className="coding-button"
                    disabled={action}
                    onClick={() => goalAction('cancel')}
                  >
                    结束目标
                  </button>
                </div>
              )}
            </article>
          )}
        </section>
      )}
      {panel === 'team' && (
        <section className="coding-orchestration-body" aria-label="子 Agent 和工作会话">
          <CodingSubagentSettings agents={subagents} onChange={updateSubagents} />
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void perform(async () => {
                const value = await orchestrationAPI.createWorker(
                  session.id,
                  role,
                  role === 'worker' ? workerMode : 'plan',
                  task,
                  workerModel,
                )
                updateWorker(value)
                setTask('')
              })
            }}
          >
            <div className="coding-actions">
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger aria-label="工作类型">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="worker">工作会话</SelectItem>
                  {subagents
                    .filter((item) => item.enabled)
                    .map((item) => (
                      <SelectItem key={item.name} value={item.name}>
                        {item.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {role === 'worker' && <RunMode value={workerMode} onChange={setWorkerMode} />}
            </div>
            <CodingModelFields
              value={workerModel}
              onChange={setWorkerModel}
              disabled={action}
              defaultLabel="使用子 Agent 或当前会话模型"
            />
            <label>
              委派任务
              <Textarea
                rows={3}
                maxLength={12000}
                required
                value={task}
                onChange={(event) => setTask(event.target.value)}
              />
            </label>
            <button className="coding-button coding-primary" disabled={action || !task.trim()}>
              开始任务
            </button>
          </form>
          {workers.map((worker) => (
            <article key={worker.id} className="coding-orchestration-record">
              <h3>
                {roleLabel(worker.role)}
                <small>
                  {statuses[worker.status]} · {worker.mode === 'plan' ? '只读' : '可编辑'}
                  {worker.accepted && ' · 报告已采纳'}
                </small>
              </h3>
              <p>{worker.task}</p>
              {worker.result && (
                <details>
                  <summary>工作报告</summary>
                  <p>{worker.result}</p>
                </details>
              )}
              {worker.error && <p className="coding-muted">{worker.error}</p>}
              <div className="coding-actions">
                <button
                  type="button"
                  className="coding-button"
                  onClick={() => onOpenSession(worker.id)}
                >
                  打开会话
                </button>
                {worker.status === 'completed' && !worker.accepted && (
                  <button
                    type="button"
                    className="coding-button"
                    disabled={action}
                    onClick={() => {
                      void perform(async () =>
                        updateWorker(
                          await orchestrationAPI.workerAction(session.id, worker.id, 'accept'),
                        ),
                      )
                    }}
                  >
                    采纳报告
                  </button>
                )}
                {worker.status === 'running' ? (
                  <button
                    type="button"
                    className="coding-button"
                    disabled={action}
                    onClick={() => {
                      void perform(async () => {
                        updateWorker(
                          await orchestrationAPI.workerAction(session.id, worker.id, 'cancel'),
                        )
                        settled.current?.()
                      })
                    }}
                  >
                    停止
                  </button>
                ) : (
                  <button
                    type="button"
                    className="coding-button"
                    disabled={action}
                    onClick={() => {
                      setFollowUpID(followUpID === worker.id ? '' : worker.id)
                      setFollowUp('')
                    }}
                  >
                    追加任务
                  </button>
                )}
              </div>
              {followUpID === worker.id && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    void perform(async () => {
                      updateWorker(
                        await orchestrationAPI.workerAction(
                          session.id,
                          worker.id,
                          'send',
                          followUp,
                        ),
                      )
                      setFollowUpID('')
                      setFollowUp('')
                    })
                  }}
                >
                  <label>
                    追加任务
                    <Textarea
                      rows={2}
                      required
                      maxLength={12000}
                      value={followUp}
                      onChange={(event) => setFollowUp(event.target.value)}
                    />
                  </label>
                  <button
                    className="coding-button coding-primary"
                    disabled={action || !followUp.trim()}
                  >
                    追加并运行
                  </button>
                </form>
              )}
            </article>
          ))}
        </section>
      )}
    </div>
  )
}
