/**
 * 文件职责：抖音直播配置表单。
 * 编辑直播间、轮询/回复节奏、提示词与各消息类型的接收/自动回应开关。
 */
import { Save } from 'lucide-react'
import { liveKinds } from '../../api/live'
import type { LiveConfig, LiveKind } from '../../api/live'
import { Textarea } from '../ui/textarea'

// 数值字段的输入范围，预算与节奏都限制在合理区间内。
const numbers = [
  { key: 'temperature', label: '温度', min: 0, max: 2, step: 0.1 },
  { key: 'poll_seconds', label: '开播轮询（秒）', min: 5, max: 300, step: 1 },
  { key: 'reply_seconds', label: '自动回复间隔（秒）', min: 2, max: 120, step: 1 },
  { key: 'batch_size', label: '每轮事件上限', min: 1, max: 12, step: 1 },
  { key: 'max_tokens', label: '回复 token 上限', min: 32, max: 2048, step: 1 },
] as const

/** 直播配置表单属性。 */
interface Props {
  value: LiveConfig
  labels: Record<LiveKind, string>
  /** 直播进行中，部分字段不可修改 */
  running: boolean
  /** 有命令执行中，表单整体只读 */
  pending: boolean
  dirty: boolean
  change: (config: LiveConfig) => void
  save: () => void
}

/** 抖音直播配置表单。 */
export default function LiveModeSettings({
  value,
  labels,
  running,
  pending,
  dirty,
  change,
  save,
}: Props) {
  function toggle(kind: LiveKind, group: 'events' | 'reply_events', checked: boolean) {
    const next = { ...value }
    const selected = new Set(value[group] ?? [])
    if (checked) selected.add(kind)
    else selected.delete(kind)
    next[group] = liveKinds.filter((item) => selected.has(item))
    // 取消接收某类消息时，必须同时取消它的自动回应，避免配置出现不一致。
    if (group === 'events' && !checked)
      next.reply_events = value.reply_events?.filter((item) => item !== kind) ?? []
    change(next)
  }

  return (
    <form
      className="live-card live-settings"
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
    >
      <div className="live-fields">
        <label className="live-room-field">
          抖音直播间
          <input
            value={value.room}
            placeholder="直播间 ID 或 live.douyin.com 链接"
            disabled={running || pending}
            onChange={(e) => change({ ...value, room: e.target.value })}
          />
        </label>
        {numbers.map(({ key, label, min, max, step }) => (
          <label key={key}>
            {label}
            <input
              type="number"
              min={min}
              max={max}
              step={step}
              value={value[key]}
              // 相关的节奏参数在监听中会直接影响已建立的连接，禁止运行时修改。
              disabled={pending || (key === 'poll_seconds' && running)}
              onChange={(e) => change({ ...value, [key]: Number(e.target.value) })}
            />
          </label>
        ))}
      </div>
      <label className="live-prompt">
        直播提示词
        <Textarea
          rows={3}
          value={value.prompt}
          maxLength={3000}
          disabled={pending}
          onChange={(e) => change({ ...value, prompt: e.target.value })}
        />
      </label>
      <div className="live-event-options">
        <table>
          <thead>
            <tr>
              <th scope="col">消息类型</th>
              <th scope="col">接收</th>
              <th scope="col">自动回应</th>
            </tr>
          </thead>
          <tbody>
            {liveKinds.map((kind) => {
              const checked = value.events?.includes(kind) ?? false
              return (
                <tr key={kind}>
                  <th scope="row">{labels[kind]}</th>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`接收${labels[kind]}`}
                      checked={checked}
                      disabled={pending}
                      onChange={(e) => toggle(kind, 'events', e.target.checked)}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`自动回应${labels[kind]}`}
                      checked={value.reply_events?.includes(kind) ?? false}
                      disabled={pending || !checked}
                      onChange={(e) => toggle(kind, 'reply_events', e.target.checked)}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="live-output-options">
          <label>
            <input
              type="checkbox"
              checked={value.speak}
              disabled={pending}
              onChange={(e) => change({ ...value, speak: e.target.checked })}
            />{' '}
            朗读 AI 回复
          </label>
          <label>
            <input
              type="checkbox"
              checked={value.actions}
              disabled={pending}
              onChange={(e) => change({ ...value, actions: e.target.checked })}
            />{' '}
            允许 AI 执行角色动作和表情
          </label>
        </div>
      </div>
      <button className="button primary" type="submit" disabled={pending || !dirty}>
        <Save size={15} /> 保存直播配置
      </button>
    </form>
  )
}
