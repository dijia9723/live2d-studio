/** 文件职责：只在自动计数运行时刷新展示时钟，不把每次跳数写入存储。 */
import { useEffect, useState } from 'react'
import type { CanvasCounter } from '../types/canvas'

/** 返回计数展示时刻；实际数值仍由持久化的基准值和时间戳计算。 */
export function useCanvasClock(counters: CanvasCounter[]) {
  const active = counters.some((counter) => counter.mode === 'auto' && counter.running)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(timer)
  }, [active])
  return active ? now : Date.now()
}
