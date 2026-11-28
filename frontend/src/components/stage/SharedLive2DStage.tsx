/**
 * 文件职责：跨路由共享的 Live2D 舞台。
 * 把唯一的 Live2DStage 挂在布局层保持存活，各页面只提供舞台落点，
 * 路由切换时直接移动画布节点，不销毁 WebGL 上下文或重新加载模型。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import Live2DStage from './Live2DStage'
import type { Live2DCapabilities, Live2DStageHandle } from './Live2DStage'
import type { ActionNames } from '../../types/api'
import type { CameraSample } from '../../utils/cameraTracking'

interface StageConfig {
  modelPath: string
  actionNames?: ActionNames
  cameraSample?: RefObject<CameraSample | null>
  onCapabilitiesChange?: (capabilities: Live2DCapabilities) => void
  onInteraction?: (message: string) => void
}

interface SharedStageContextValue {
  stageRef: RefObject<Live2DStageHandle | null>
  setConfig: (config: StageConfig) => void
  attachSlot: (slot: HTMLElement) => void
  detachSlot: (slot: HTMLElement) => void
}

const SharedStageContext = createContext<SharedStageContextValue | null>(null)

function useSharedStageContext() {
  const value = useContext(SharedStageContext)
  if (!value) throw new Error('共享 Live2D 舞台必须在 SharedLive2DStageProvider 内使用')
  return value
}

/** 布局层提供者：保持舞台存活，并把画布移动到当前页面注册的落点。 */
export function SharedLive2DStageProvider({ children }: { children: ReactNode }) {
  const stageRoot = useRef<HTMLDivElement | null>(null)
  if (!stageRoot.current) {
    stageRoot.current = document.createElement('div')
    stageRoot.current.className = 'shared-live2d-root'
  }
  const parking = useRef<HTMLDivElement>(null)
  const activeSlot = useRef<HTMLElement | null>(null)
  const stageRef = useRef<Live2DStageHandle>(null)
  const [config, setConfig] = useState<StageConfig | null>(null)

  const attachSlot = useCallback((slot: HTMLElement) => {
    const root = stageRoot.current
    if (!root) return
    activeSlot.current = slot
    if (root.parentElement !== slot) slot.replaceChildren(root)
  }, [])

  const detachSlot = useCallback((slot: HTMLElement) => {
    // 新页面已接管画布时不要把它藏起来。
    if (activeSlot.current !== slot) return
    activeSlot.current = null
    const root = stageRoot.current
    if (root && parking.current) parking.current.replaceChildren(root)
  }, [])

  // 布局卸载时同步移除手动创建的画布节点。
  useEffect(() => {
    const root = stageRoot.current
    return () => root?.remove()
  }, [])

  const value = useMemo(
    () => ({ stageRef, setConfig, attachSlot, detachSlot }),
    [attachSlot, detachSlot],
  )

  return (
    <SharedStageContext.Provider value={value}>
      {children}
      <div ref={parking} className="shared-live2d-parking" aria-hidden="true" />
      {config &&
        stageRoot.current &&
        createPortal(
          <Live2DStage
            ref={stageRef}
            modelPath={config.modelPath}
            actionNames={config.actionNames}
            cameraSample={config.cameraSample}
            stagePlacement
            onCapabilitiesChange={config.onCapabilitiesChange}
            onInteraction={config.onInteraction}
          />,
          stageRoot.current,
        )}
    </SharedStageContext.Provider>
  )
}

/**
 * 页面接入共享舞台。
 * @returns stageRef：唯一的舞台控制句柄；stageSlotRef：当前页面承载画布的 DOM 落点。
 */
export function useSharedLive2DStage({
  enabled = true,
  modelPath,
  actionNames,
  cameraSample,
  onCapabilitiesChange,
  onInteraction,
}: {
  enabled?: boolean
  modelPath?: string
  actionNames?: ActionNames
  cameraSample?: RefObject<CameraSample | null>
  onCapabilitiesChange?: (capabilities: Live2DCapabilities) => void
  onInteraction?: (message: string) => void
}) {
  const shared = useSharedStageContext()
  const config = useMemo<StageConfig | null>(
    () =>
      modelPath
        ? { modelPath, actionNames, cameraSample, onCapabilitiesChange, onInteraction }
        : null,
    [modelPath, actionNames, cameraSample, onCapabilitiesChange, onInteraction],
  )

  // 切换角色或动作命名时才更新配置；同模型跨页面切换不会重建舞台。
  useEffect(() => {
    if (enabled && config) shared.setConfig(config)
  }, [enabled, config, shared])

  const stageSlotRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return
      shared.attachSlot(node)
      return () => shared.detachSlot(node)
    },
    [shared],
  )

  return { stageRef: shared.stageRef, stageSlotRef }
}
