import { useState } from 'react'
import { orchestrationAPI, type CodingSubagent } from '../api/codingOrchestration'
import { CodingModelFields } from './CodingSessionModel'

const emptySubagent = { name: '', label: '', instructions: '', enabled: true, builtin: false }

export default function CodingSubagentSettings({
  agents,
  onChange,
}: {
  agents: CodingSubagent[]
  onChange: (items: CodingSubagent[]) => void
}) {
  const [editor, setEditor] = useState<{ agent: CodingSubagent; fresh: boolean }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const update = (patch: Partial<CodingSubagent>) => {
    setEditor((current) => current && { ...current, agent: { ...current.agent, ...patch } })
  }

  const perform = async (work: () => Promise<unknown>, close = false) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await work()
      onChange(await orchestrationAPI.subagents())
      if (close) setEditor(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '子 Agent 操作失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="coding-orchestration-record">
      <summary>管理子 Agent</summary>
      {error && (
        <p className="coding-alert" role="alert">
          {error}
        </p>
      )}
      <div className="coding-agent-definitions">
        {agents.map((item) => (
          <div className="coding-actions" key={item.name}>
            <label>
              <input
                type="checkbox"
                checked={item.enabled}
                disabled={busy || !!editor}
                aria-label={`启用 ${item.label}`}
                onChange={(event) => {
                  const next = { ...item, enabled: event.target.checked }
                  void perform(() => orchestrationAPI.saveSubagent(next))
                }}
              />
              {item.label}
            </label>
            <button
              type="button"
              className="coding-button"
              disabled={busy}
              aria-label={`编辑 ${item.label}`}
              onClick={() => setEditor({ agent: item, fresh: false })}
            >
              编辑
            </button>
          </div>
        ))}
      </div>
      {!editor && (
        <button
          type="button"
          className="coding-button"
          disabled={busy}
          onClick={() => setEditor({ agent: { ...emptySubagent }, fresh: true })}
        >
          新建子 Agent
        </button>
      )}
      {editor && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (editor.fresh && agents.some((item) => item.name === editor.agent.name)) {
              setError('已存在同名子 Agent，请使用不同的标识')
              return
            }
            void perform(() => orchestrationAPI.saveSubagent(editor.agent), true)
          }}
        >
          <label>
            Agent 标识
            <input
              required
              maxLength={48}
              disabled={!editor.fresh}
              pattern={String.raw`[a-z][a-z0-9\-]{0,47}`}
              value={editor.agent.name}
              onChange={(event) => update({ name: event.target.value })}
            />
          </label>
          <label>
            显示名称
            <input
              required
              maxLength={80}
              value={editor.agent.label}
              onChange={(event) => update({ label: event.target.value })}
            />
          </label>
          <label>
            任务说明
            <textarea
              rows={3}
              required
              maxLength={6000}
              value={editor.agent.instructions}
              onChange={(event) => update({ instructions: event.target.value })}
            />
          </label>
          <CodingModelFields
            value={{
              model_provider: editor.agent.model_provider || '',
              model_name: editor.agent.model_name || '',
            }}
            onChange={update}
            disabled={busy}
            defaultLabel="继承当前会话模型"
          />
          <div className="coding-actions">
            <button className="coding-button coding-primary" disabled={busy}>
              保存子 Agent
            </button>
            <button
              type="button"
              className="coding-button"
              disabled={busy}
              onClick={() => setEditor(undefined)}
            >
              取消
            </button>
            {!editor.fresh && (
              <button
                type="button"
                className="coding-button"
                disabled={busy}
                onClick={() =>
                  void perform(() => orchestrationAPI.resetSubagent(editor.agent.name), true)
                }
              >
                {editor.agent.builtin ? '恢复默认' : '删除定义'}
              </button>
            )}
          </div>
        </form>
      )}
    </details>
  )
}
