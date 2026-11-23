/**
 * 文件职责：角色动作/表情显示名称的解析。
 * 优先使用用户自定义名称，缺失时回退到模型清单中的默认名称。
 */
import type { ActionNames } from '../types/api'

/** 预设情绪 ID 到中文名的映射。 */
export const moodNames: Record<string, string> = {
  neutral: '自然',
  happy: '开心',
  sad: '难过',
  surprised: '惊讶',
}

// JSON 的转义和空白写法不会改变动作的组名与索引。
function motionKey(id: string) {
  try {
    return JSON.stringify(JSON.parse(id))
  } catch {
    return id
  }
}

/**
 * 取动作/表情的显示名称。
 * @param names 用户保存的名称表
 * @param kind 动作类别（motions/expressions 等）
 * @param id 资源 ID
 * @param fallback 未找到自定义名称时使用的默认名
 */
export function actionDisplayName(
  names: ActionNames | undefined,
  kind: keyof ActionNames,
  id: string,
  fallback: string,
) {
  const entries = names?.[kind]
  // 先精确匹配；动作 ID 是 JSON 串，再做一次规范化匹配以兼容空白/转义差异。
  const direct = entries && Object.hasOwn(entries, id) ? entries[id] : undefined
  if (direct?.trim()) return direct.trim()
  if (kind === 'motions' && entries) {
    const key = motionKey(id)
    const match = Object.entries(entries).find(([savedID]) => motionKey(savedID) === key)?.[1]
    if (match?.trim()) return match.trim()
  }
  return fallback
}
