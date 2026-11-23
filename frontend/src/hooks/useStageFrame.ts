/** 根据可用空间等比容纳画布；全屏和窗口变化时沿用同一份构图。 */
import { useLayoutEffect, useRef, useState } from 'react'
import { stageAspectPresets, type StageAspect } from '../types/stage'

export function useStageFrame(aspect: StageAspect, ready = true) {
  const ref = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  // 切换比例会同时改变工作台两栏宽度，这里重新测量一次，保证舞台立刻按新空间排版。
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const measure = () => {
      const { width, height } = node.getBoundingClientRect()
      setBounds((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [ready, aspect])
  const ratio = stageAspectPresets.find((preset) => preset.id === aspect)?.ratio ?? 0
  const width = ratio ? Math.min(bounds.width, bounds.height * ratio) : bounds.width
  const height = ratio ? width / ratio : bounds.height
  return {
    ref,
    // 小画布同步缩放字体、HTML 和安全边距，避免只缩小元素边框而挤掉内容。
    contentScale: width && height ? Math.max(0.1, Math.min(1, width / 320, height / 380)) : 1,
    style: bounds.width && bounds.height ? { width, height } : undefined,
  }
}
