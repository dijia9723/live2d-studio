import type { ActionNames } from '../types/api'

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

export function actionDisplayName(
  names: ActionNames | undefined,
  kind: keyof ActionNames,
  id: string,
  fallback: string,
) {
  const entries = names?.[kind]
  const direct = entries && Object.hasOwn(entries, id) ? entries[id] : undefined
  if (direct?.trim()) return direct.trim()
  if (kind === 'motions' && entries) {
    const key = motionKey(id)
    const match = Object.entries(entries).find(([savedID]) => motionKey(savedID) === key)?.[1]
    if (match?.trim()) return match.trim()
  }
  return fallback
}
