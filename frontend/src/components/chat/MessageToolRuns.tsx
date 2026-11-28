/**
 * 文件职责：助手消息中的工具调用状态列表（调用中/已完成/失败/已中断）。
 */
import { Check, LoaderCircle, Wrench, X } from 'lucide-react'
import type { ToolRun } from '../../types/api'

// 后端工具名到中文展示名的映射，未知工具直接显示原名。
const names = new Map([
  ['current_time', '查询时间'],
  ['set_expression', '切换表情'],
  ['calculate', '计算'],
  ['search_memories', '查找角色记忆'],
  ['save_memory', '保存角色记忆'],
  ['update_character', '修改角色设定'],
  ['get_character_actions', '查询模型动作'],
  ['play_motion', '发送动作播放请求'],
  ['request_screen_snip', '请求用户截图'],
  ['set_model_expression', '发送模型表情请求'],
  ['unknown_tool', '未知工具'],
])
const statuses = {
  running: { label: '调用中', Icon: LoaderCircle },
  completed: { label: '已完成', Icon: Check },
  failed: { label: '失败', Icon: X },
  interrupted: { label: '已中断', Icon: Wrench },
}

/**
 * @param runs 工具调用记录
 * @param active 消息是否仍在流式生成；非活动状态下 running 视为已中断
 */
export default function MessageToolRuns({ runs, active }: { runs: ToolRun[]; active: boolean }) {
  return (
    <ul
      className="message-tool-runs"
      aria-label="工具调用"
      aria-live={active ? 'polite' : undefined}
    >
      {runs.map((run) => {
        const status = run.status === 'running' && !active ? 'interrupted' : run.status
        const { label, Icon } = statuses[status]
        return (
          <li key={run.id} data-status={status}>
            <Icon
              size={12}
              aria-hidden="true"
              className={status === 'running' ? 'spin' : undefined}
            />
            {names.get(run.name) ?? run.name} · {label}
          </li>
        )
      })}
    </ul>
  )
}
