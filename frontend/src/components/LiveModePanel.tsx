import { useState } from 'react'
import {
  Check,
  ChevronRight,
  CircleAlert,
  FlaskConical,
  Gift,
  Heart,
  LoaderCircle,
  MessageSquare,
  Play,
  Radio,
  Square,
  UserPlus,
  Users,
  VolumeX,
} from 'lucide-react'
import { liveKinds } from '../api/live'
import type { LiveEvent, LiveKind, LiveMode, LiveState } from '../api/live'
import LiveModeSettings from './LiveModeSettings'
import type { useLiveMode } from '../hooks/useLiveMode'
import { useStudio } from '../store/studio'

const labels: Record<LiveKind, string> = {
  chat: '弹幕',
  gift: '礼物',
  like: '点赞',
  enter: '进场',
  follow: '关注',
}
const icons = { chat: MessageSquare, gift: Gift, like: Heart, enter: Users, follow: UserPlus }
const phases: Record<LiveState['phase'], string> = {
  stopped: '已停止',
  checking: '查询开播状态',
  waiting: '等待开播',
  connecting: '正在连接',
  live: '接收直播消息',
  retrying: '等待重试',
  demo: '演练进行中',
}
const modes: Record<LiveMode, string> = { manual: '手动回应', auto: '自动回应', paused: '暂停 AI' }
const time = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

function eventDescription(event: LiveEvent) {
  switch (event.kind) {
    case 'chat':
      return event.text
    case 'gift':
      return `送出 ${event.text ?? '礼物'} ×${event.count}`
    case 'like':
      return `点赞 ×${event.count}`
    case 'enter':
      return '进入了直播间'
    case 'follow':
      return '关注了直播间'
  }
}

interface Props {
  live: ReturnType<typeof useLiveMode>
  characterID: string
  chatBusy: boolean
  speaking: boolean
  stageFeedback: string
  stopSpeaking: () => void
  selectHost: (id: string) => void
}

export default function LiveModePanel({
  live,
  characterID,
  chatBusy,
  speaking,
  stageFeedback,
  stopSpeaking,
  selectHost,
}: Props) {
  const { state, form, working: locked, error, dirty, save, setMode } = live
  const roles = useStudio((s) => s.characters)
  const model = useStudio((s) => s.settings?.llm.model)
  const [filter, setFilter] = useState<LiveKind | 'all'>('all')
  const replies = state?.replies ?? []
  const needsHost = state?.running && characterID !== state.config.character_id
  const host = needsHost ? roles.find(({ id }) => id === state.config.character_id) : undefined
  const visible = (state?.events ?? [])
    .filter((event) => filter === 'all' || event.kind === filter)
    .reverse()
  return (
    <div className="live-panel">
      <header className="live-header">
        <div>
          <h2>抖音直播</h2>
          <p>{state?.title || (state?.config.room ? `抖音直播间 · ${state.config.room}` : '')}</p>
        </div>
        <div className="live-header-actions">
          {state?.running ? (
            <button className="button ghost" disabled={locked} onClick={live.stop}>
              <Square size={15} /> 停止监听
            </button>
          ) : (
            <>
              <button
                className="button ghost"
                disabled={locked || !form}
                onClick={() => save('demo')}
              >
                <FlaskConical size={15} /> 直播演练
              </button>
              <button
                className="button primary"
                disabled={locked || !form?.room.trim()}
                onClick={() => save('real')}
              >
                <Play size={15} /> 开始监听
              </button>
            </>
          )}
        </div>
      </header>
      {error && (
        <div className="live-alert" role="alert">
          <CircleAlert size={16} />
          {error}
        </div>
      )}
      {!state || !form ? (
        <p className="live-loading">
          <LoaderCircle size={17} className="spin" /> 正在读取直播配置
        </p>
      ) : (
        <>
          <div className="live-toolbar">
            <span className="live-connection" data-phase={state.phase} role="status">
              <Radio size={14} /> {phases[state.phase]}
            </span>
            <div className="live-mode-switch" role="group" aria-label="直播互动状态">
              {(Object.keys(modes) as LiveMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  disabled={locked}
                  aria-pressed={state.config.mode === mode}
                  onClick={() => setMode(mode)}
                >
                  {modes[mode]}
                </button>
              ))}
            </div>
            <span className="live-meta">
              {state.busy ? 'AI 正在生成' : state.pending ? `${state.pending} 条待回应` : model}
            </span>
          </div>
          {needsHost && (
            <div className="live-alert" role="status">
              <CircleAlert size={16} />
              {host ? (
                <button
                  type="button"
                  className="text-link"
                  disabled={chatBusy}
                  onClick={() => selectHost(host.id)}
                >
                  切回 {host.name} 继续回应
                </button>
              ) : (
                <span>直播角色已移除，结束监听后可以重新选择角色。</span>
              )}
            </div>
          )}
          <section className="live-card live-feed" aria-label="直播消息">
            <div className="live-panel-heading">
              <h2>直播消息</h2>
              <span>{state.events?.length ?? 0} 条</span>
            </div>
            <div className="live-filters" role="group" aria-label="筛选直播消息">
              <button
                type="button"
                aria-pressed={filter === 'all'}
                onClick={() => setFilter('all')}
              >
                全部
              </button>
              {liveKinds.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={filter === kind}
                  onClick={() => setFilter(kind)}
                >
                  {labels[kind]} <small>{state.counts?.[kind] ?? 0}</small>
                </button>
              ))}
            </div>
            {state.demo && state.running && (
              <div className="live-demo" role="group" aria-label="模拟观众消息">
                <span>模拟一条</span>
                {liveKinds
                  .filter((kind) => state.config.events?.includes(kind))
                  .map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      disabled={locked}
                      onClick={() => live.demoEvent(kind)}
                    >
                      {labels[kind]}
                    </button>
                  ))}
              </div>
            )}
            {visible.length ? (
              <ul className="live-events">
                {visible.map((event) => {
                  const Icon = icons[event.kind]
                  return (
                    <li key={event.id}>
                      <span className="live-event-icon" data-kind={event.kind}>
                        <Icon size={16} aria-label={labels[event.kind]} />
                      </span>
                      <div>
                        <strong>{event.viewer || '观众'}</strong>
                        <p>{eventDescription(event)}</p>
                      </div>
                      <time dateTime={event.at}>{time.format(new Date(event.at))}</time>
                      <button
                        type="button"
                        disabled={!live.canReply}
                        className="icon-button"
                        aria-label={`回应${event.viewer || '观众'}的${labels[event.kind]}`}
                        title="交给 AI 回应"
                        onClick={() => live.reply(event.id)}
                      >
                        <ChevronRight size={16} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="live-empty">
                {state.running ? '等待该类型的直播消息' : '开始监听或用直播演练试一下互动'}
              </p>
            )}
          </section>
          {!!replies.length && (
            <section className="live-card live-replies">
              <div className="live-panel-heading">
                <h2>AI 回应</h2>
                {speaking && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="停止直播朗读"
                    title="停止直播朗读"
                    onClick={stopSpeaking}
                  >
                    <VolumeX size={16} />
                  </button>
                )}
              </div>
              {stageFeedback && !needsHost && state.running && (
                <p className="live-action-feedback">{stageFeedback}</p>
              )}
              <ul>
                {[...replies].reverse().map((reply) => (
                  <li key={reply.id} data-error={!!reply.error}>
                    {reply.error ? <CircleAlert size={15} /> : <Check size={15} />}
                    <p>{reply.error || reply.text}</p>
                    <time dateTime={reply.at}>{time.format(new Date(reply.at))}</time>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <LiveModeSettings
            value={form}
            labels={labels}
            running={state.running}
            pending={locked}
            dirty={dirty}
            change={live.setForm}
            save={() => save()}
          />
        </>
      )}
    </div>
  )
}
