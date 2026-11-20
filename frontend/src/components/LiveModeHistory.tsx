import { useEffect, useRef, useState } from 'react'
import { liveAPI, liveKinds } from '../api/live'
import type { LiveKind, LiveSession, LiveSessionDetails } from '../api/live'

const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
const states = { recording: '记录中', ended: '已结束', interrupted: '记录中断' }

function duration(session: LiveSession) {
  if (!session.ended_at) return ''
  const seconds = Math.max(
    0,
    Math.floor((Date.parse(session.ended_at) - Date.parse(session.started_at)) / 1000),
  )
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours ? `${hours} 小时 ` : ''}${minutes ? `${minutes} 分 ` : ''}${seconds % 60} 秒`
}

interface Props {
  labels: Record<LiveKind, string>
  recordingID?: string
}

export default function LiveModeHistory({ labels, recordingID }: Props) {
  const [page, setPage] = useState(0)
  const [records, setRecords] = useState<Awaited<ReturnType<typeof liveAPI.sessions>>>()
  const [selected, setSelected] = useState('')
  const [detail, setDetail] = useState<LiveSessionDetails>()
  const [listError, setListError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const generation = useRef<AbortController | null>(null)

  useEffect(() => {
    const abort = new AbortController()
    setListError('')
    setRecords(undefined)
    void liveAPI.sessions(page, abort.signal).then(
      (result) => {
        if (abort.signal.aborted) return
        setRecords(result)
        setSelected((id) =>
          result.sessions.some((session) => session.id === id)
            ? id
            : (result.sessions[0]?.id ?? ''),
        )
      },
      (error: Error) => {
        if (!abort.signal.aborted) setListError(error.message)
      },
    )
    return () => abort.abort()
  }, [page, recordingID, refresh])

  useEffect(() => {
    const abort = new AbortController()
    setDetail(undefined)
    setDetailError('')
    setBusy(false)
    if (selected) {
      void liveAPI.session(selected, abort.signal).then(
        (result) => {
          if (!abort.signal.aborted) setDetail(result)
        },
        (error: Error) => {
          if (!abort.signal.aborted) setDetailError(error.message)
        },
      )
    }
    return () => {
      abort.abort()
      generation.current?.abort()
      generation.current = null
    }
  }, [recordingID, refresh, selected])

  async function summarize(id: string) {
    if (generation.current) return
    const abort = new AbortController()
    generation.current = abort
    setDetailError('')
    setBusy(true)
    try {
      const result = await liveAPI.summarize(id, abort.signal)
      if (!abort.signal.aborted) setDetail(result)
    } catch (error) {
      if (!abort.signal.aborted)
        setDetailError(error instanceof Error ? error.message : '生成总结失败')
    } finally {
      if (generation.current === abort) {
        generation.current = null
        setBusy(false)
      }
    }
  }

  const current = detail?.id === selected ? detail : undefined
  const hasData = current && (Object.keys(current.counts).length > 0 || current.reply_count > 0)
  const elapsed = current ? duration(current) : ''

  return (
    <>
      <section className="live-card live-history">
        <div className="live-panel-heading">
          <h2>直播记录</h2>
          <button
            type="button"
            className="text-link"
            onClick={() => setRefresh(refresh + 1)}
            disabled={busy}
          >
            刷新
          </button>
        </div>
        {listError ? (
          <p className="live-empty" role="alert">
            {listError}
          </p>
        ) : !records ? (
          <p className="live-empty" role="status">
            正在读取直播记录
          </p>
        ) : records.sessions.length ? (
          <ul className="live-session-list">
            {records.sessions.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  aria-pressed={selected === session.id}
                  onClick={() => setSelected(session.id)}
                >
                  <strong>{session.title || `抖音直播间 ${session.room}`}</strong>
                  <small>
                    {dateTime.format(new Date(session.started_at))} · {states[session.status]}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="live-empty">还没有直播记录。检测到开播后会开始保存。</p>
        )}
        {(page > 0 || records?.has_more) && (
          <div className="live-history-controls">
            <button
              className="button ghost"
              type="button"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              上一页
            </button>
            <button
              className="button ghost"
              type="button"
              disabled={!records?.has_more}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </button>
          </div>
        )}
      </section>
      {selected && (
        <section className="live-card live-history">
          <div className="live-panel-heading">
            <h2>本场汇总</h2>
          </div>
          {detailError && (
            <p className="live-empty" role="alert">
              {detailError}
            </p>
          )}
          {current ? (
            <div className="live-history-detail">
              <p className="live-history-meta">
                {current.character_name} · {states[current.status]}
                {elapsed && ` · 监听时长 ${elapsed}`}
              </p>
              <p className="live-history-meta">统计范围为监听期间收到的互动。</p>
              {(current.incomplete || current.status === 'interrupted') && (
                <p className="live-history-meta">本场记录可能不完整。</p>
              )}
              <dl className="live-history-stats">
                {liveKinds.map((kind) => (
                  <div key={kind}>
                    <dt>{labels[kind]}</dt>
                    <dd>{(current.counts[kind] ?? 0).toLocaleString('zh-CN')}</dd>
                  </div>
                ))}
                <div>
                  <dt>AI 回应</dt>
                  <dd>{current.reply_count.toLocaleString('zh-CN')}</dd>
                </div>
              </dl>
              {current.failed_replies > 0 && (
                <p className="live-history-meta">{current.failed_replies} 条 AI 回应失败</p>
              )}
              {current.gifts.length > 0 && (
                <div>
                  <h3>礼物排行</h3>
                  <p>
                    {current.gifts
                      .map(({ name, count }) => `${name} ×${count.toLocaleString('zh-CN')}`)
                      .join('、')}
                  </p>
                </div>
              )}
              {current.summary ? (
                <div>
                  <h3>AI 复盘</h3>
                  <p className="live-summary-text">{current.summary}</p>
                </div>
              ) : (
                current.status !== 'recording' &&
                hasData && (
                  <button
                    className="button primary"
                    type="button"
                    onClick={() => void summarize(current.id)}
                    disabled={busy}
                  >
                    {busy ? '正在生成复盘…' : '生成 AI 复盘'}
                  </button>
                )
              )}
            </div>
          ) : (
            !detailError && (
              <p className="live-empty" role="status">
                正在汇总本场互动
              </p>
            )
          )}
        </section>
      )}
    </>
  )
}
