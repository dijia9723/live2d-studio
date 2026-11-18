/**
 * 文件职责：Live2D 画布组件。
 * 负责加载 Cubism Core 与模型、计算缩放布局、鼠标/摄像头跟随、点击播放动作、
 * 情绪参数/模型原生表情切换、口型同步，并在卸载时按顺序释放资源。
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Application, Ticker } from 'pixi.js'
import { AlertCircle, LoaderCircle, RotateCcw } from 'lucide-react'
import type { Cubism4InternalModel, Live2DModel } from 'pixi-live2d-display/cubism4'
import { notify, useStudio } from '../store/studio'
import {
  chooseMotion,
  createParameterBindings,
  lipSyncParameters,
  modelCapabilities,
  moodParameters,
} from '../utils/live2d'
import type { Live2DCapabilities } from '../utils/live2d'
import type { ActionNames } from '../types/api'
import { actionDisplayName, moodNames } from '../utils/actionNames'
import {
  createCameraParameterDriver,
  currentCameraSample,
  type CameraSample,
} from '../utils/cameraTracking'

export type { Live2DCapabilities } from '../utils/live2d'

/** 通过 ref 暴露给父组件的舞台控制接口。 */
export interface Live2DStageHandle {
  setMood(mood: string): void
  setExpression(name: string | null): Promise<boolean>
  playMotion(id?: string): Promise<boolean>
  reset(): void
}

const emptyCapabilities = (): Live2DCapabilities => ({
  ready: false,
  expressions: [],
  motions: [],
  supportsMoods: false,
})

// Cubism Core 是全局脚本，多个舞台共享同一次加载（模块级 Promise 缓存）。
let corePromise: Promise<void> | undefined
function loadCore() {
  if ((window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore)
    return Promise.resolve()
  if (!corePromise)
    corePromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.src = '/lib/live2dcubismcore.min.js'
      script.onload = () => resolve()
      script.onerror = () => {
        // 失败后清空缓存，允许点击“重新加载”再试。
        corePromise = undefined
        script.remove()
        reject(new Error('Cubism Core 加载失败，请检查本地运行库'))
      }
      document.head.appendChild(script)
    })
  return corePromise
}

interface Props {
  /** 模型 model3.json 路径 */
  modelPath: string
  actionNames?: ActionNames
  /** 是否为缩略图预览模式（不响应鼠标、不播口型） */
  miniature?: boolean
  /** 独立编辑预览：保持默认缩放，情绪与口型不跟随聊天状态。 */
  isolated?: boolean
  cameraSample?: RefObject<CameraSample | null>
  onCapabilitiesChange?: (capabilities: Live2DCapabilities) => void
  onInteraction?: (message: string) => void
}

const Live2DStage = forwardRef<Live2DStageHandle, Props>(function Live2DStage(
  {
    modelPath: path,
    actionNames,
    miniature = false,
    isolated = false,
    cameraSample,
    onCapabilitiesChange,
    onInteraction,
  },
  ref,
) {
  const host = useRef<HTMLDivElement>(null)
  const model = useRef<Live2DModel | null>(null)
  const capabilities = useRef(emptyCapabilities())
  const namesRef = useRef(actionNames)
  namesRef.current = actionNames
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [revision, setRevision] = useState(0)
  const zoom = useStudio((s) => s.zoom)
  const expression = useStudio((s) => s.expression)
  const expressionRevision = useStudio((s) => s.expressionRevision)
  const speaking = useStudio((s) => s.speaking)
  // 用 ref 保存最新值，供 pixi 每帧回调读取，避免重建整个舞台。
  const zoomRef = useRef(zoom)
  zoomRef.current = isolated ? 1 : zoom
  const speakingRef = useRef(speaking)
  speakingRef.current = !isolated && speaking
  const moodRef = useRef(isolated ? 'neutral' : expression)
  const nativeExpressionRef = useRef(false)
  // 版本号用于取消过期的异步表情/动作加载。
  const expressionVersion = useRef(0)
  const motionVersion = useRef(0)
  const layoutRef = useRef<() => void>(() => {})
  const callbacks = useRef({ onCapabilitiesChange, onInteraction })
  callbacks.current = { onCapabilitiesChange, onInteraction }
  const report = (message: string) => (callbacks.current.onInteraction || notify)(message)

  // 切换回情绪模式：重置原生表情并让后续帧写入情绪参数。
  const applyMood = (mood: string) => {
    ++expressionVersion.current
    moodRef.current = mood
    nativeExpressionRef.current = false
    // 取消进行中的原生表情加载，避免慢加载覆盖后续情绪。
    const manager = model.current?.internalModel.motionManager.expressionManager
    if (manager) {
      manager.reserveExpressionIndex = -1
      manager.resetExpression()
    }
  }

  const playMotion = async (id?: string) => {
    const version = ++motionVersion.current
    const live = model.current
    if (!live || !capabilities.current.ready) {
      report('角色仍在加载，请稍后再试')
      return false
    }
    const motion = chooseMotion(capabilities.current.motions, id)
    if (!motion) {
      report(id ? '当前角色没有这个动作' : '当前角色没有可播放的动作')
      return false
    }
    try {
      // 单独使用 FORCE 会拒绝已激活的动作，因此先清空现有动作预留。
      live.internalModel.motionManager.stopAllMotions()
      const started = await live.motion(motion.group, motion.index, 3)
      // 模型已被替换或已有更新的请求时，丢弃本次结果。
      if (model.current !== live || version !== motionVersion.current) return false
      const label = actionDisplayName(namesRef.current, 'motions', motion.id, motion.label)
      report(started ? `正在播放：${label}` : `动作未能播放：${label}，请检查模型资源`)
      return started
    } catch {
      if (model.current === live && version === motionVersion.current)
        report('动作加载失败，请检查模型中的动作文件')
      return false
    }
  }

  useImperativeHandle(ref, () => ({
    setMood: (mood) => {
      applyMood(mood)
      if (!capabilities.current.ready) report('角色仍在加载，请稍后再试')
      else if (mood !== 'neutral' && !capabilities.current.supportsMoods)
        report('当前角色没有通用面部参数，请选择模型自带的表情')
      else
        report(
          `已切换为${actionDisplayName(namesRef.current, 'moods', mood, moodNames[mood] || mood)}表情`,
        )
    },
    setExpression: async (name) => {
      const live = model.current
      if (!live || !capabilities.current.ready) {
        report('角色仍在加载，请稍后再试')
        return false
      }
      // null 表示退出原生表情，回到情绪参数模式。
      if (name === null) {
        applyMood('neutral')
        report('已恢复自然表情')
        return true
      }
      if (!capabilities.current.expressions.some((e) => e.id === name)) {
        report('当前角色没有这个表情')
        return false
      }
      const version = ++expressionVersion.current
      try {
        const manager = live.internalModel.motionManager.expressionManager!
        manager.reserveExpressionIndex = -1
        manager.resetExpression()
        nativeExpressionRef.current = true
        const changed = await live.expression(name)
        if (model.current !== live || expressionVersion.current !== version) return false
        // 库对“已是当前表情”的情况返回 false，需要手动恢复一次以触发重放。
        if (!changed) manager.restoreExpression()
        const index = manager.getExpressionIndex(name)
        const available = changed || !!manager.expressions[index]
        if (!available) nativeExpressionRef.current = false
        const label = actionDisplayName(namesRef.current, 'expressions', name, name)
        report(available ? `已应用模型表情：${label}` : `表情加载失败：${label}`)
        return available
      } catch {
        if (model.current === live && version === expressionVersion.current) {
          nativeExpressionRef.current = false
          report('表情加载失败，请检查模型中的表情文件')
        }
        return false
      }
    },
    playMotion,
    reset: () => {
      ++motionVersion.current
      model.current?.internalModel.motionManager.stopAllMotions()
      applyMood('neutral')
      // 重置视线焦点，避免停留在最后一次鼠标位置。
      model.current?.internalModel.focusController.focus(0, 0, true)
      report('已重置角色表情与动作')
    },
  }))

  // 模型加载主副作用：路径、缩略图模式或重试计数变化时重建整个 pixi 舞台。
  useEffect(() => {
    const target = host.current
    if (!target) return
    let cancelled = false
    let pixi: Application | undefined
    let observer: ResizeObserver | undefined
    // 事件监听共用一个 AbortController，清理时一次性移除。
    const listeners = new AbortController()
    capabilities.current = emptyCapabilities()
    callbacks.current.onCapabilitiesChange?.(capabilities.current)
    setLoaded(false)
    setError('')
    nativeExpressionRef.current = false
    const start = async () => {
      try {
        await loadCore()
        // 动态导入 cubism4 入口，确保 Cubism Core 已就绪。
        const { Live2DModel } = await import('pixi-live2d-display/cubism4')
        if (cancelled) return
        Live2DModel.registerTicker(Ticker)
        pixi = new Application({
          backgroundAlpha: 0,
          antialias: true,
          autoDensity: true,
          resolution: Math.min(window.devicePixelRatio, 2),
          resizeTo: target,
        })
        const canvas = pixi.view as HTMLCanvasElement
        target.appendChild(canvas)
        // 模型可能没有 HitAreas，因此指针交互直接绑定在 canvas 上。
        const live = await Live2DModel.from(path, { autoInteract: false })
        // 加载期间组件已卸载/切换模型：立即释放刚加载的模型。
        if (cancelled) {
          live.destroy({ children: true, texture: false, baseTexture: false })
          return
        }
        model.current = live
        pixi.stage.addChild(live)
        const bounds = live.getLocalBounds()
        live.anchor.set(0.5, 0.5)
        // 按容器尺寸等比缩放并居中，缩略图模式忽略用户缩放。
        const layout = () => {
          if (!pixi) return
          const w = target.clientWidth,
            h = target.clientHeight
          if (!w || !h) return
          pixi.renderer.resize(w, h)
          live.scale.set(
            Math.min((w * 0.94) / bounds.width, (h * 0.97) / bounds.height) *
              (miniature ? 1 : zoomRef.current),
          )
          live.position.set(w / 2, h / 2 + h * 0.015)
        }
        layoutRef.current = layout
        layout()
        observer = new ResizeObserver(layout)
        observer.observe(target)

        const internal = live.internalModel as Cubism4InternalModel
        const core = internal.coreModel
        const parameters = core.getModel().parameters
        const bindings = createParameterBindings(
          parameters.ids,
          parameters.minimumValues,
          parameters.maximumValues,
        )
        capabilities.current = modelCapabilities(
          internal.motionManager.expressionManager?.definitions,
          internal.motionManager.definitions,
          bindings,
        )
        callbacks.current.onCapabilitiesChange?.(capabilities.current)
        const lips = lipSyncParameters(bindings, internal.motionManager.lipSyncIds)
        const driveCamera =
          cameraSample && !isolated ? createCameraParameterDriver(bindings) : undefined
        let lastCameraFrame = performance.now()
        const applyCameraParameter = (index: number, value: number, weight: number) =>
          core.setParameterValueByIndex(index, value, weight)
        // 转换模型对鼠标跟随也保留 PARAM_* 命名，这里做候选映射后回填真实参数名。
        const focusIDs = {
          idParamAngleX: ['ParamAngleX'],
          idParamAngleY: ['ParamAngleY'],
          idParamAngleZ: ['ParamAngleZ'],
          idParamEyeBallX: ['ParamEyeBallX'],
          idParamEyeBallY: ['ParamEyeBallY'],
          idParamBodyAngleX: ['ParamBodyAngleX', 'ParamBodyX'],
          idParamBreath: ['ParamBreath'],
        }
        for (const [property, candidates] of Object.entries(focusIDs)) {
          const entry = candidates.map((id) => bindings.get(id.toLowerCase())).find(Boolean)
          if (entry)
            (internal as unknown as Record<string, unknown>)[property] = parameters.ids[entry.index]
        }
        // 每帧更新前写入情绪参数与口型振幅，覆盖库默认值。
        internal.on('beforeModelUpdate', () => {
          if (miniature) return
          if (!nativeExpressionRef.current)
            for (const p of moodParameters(moodRef.current, bindings))
              core.setParameterValueByIndex(p.index, p.value)
          if (driveCamera && cameraSample) {
            const now = performance.now()
            const tracked = currentCameraSample(cameraSample.current, now)
            if (tracked) internal.focusController.focus(0, 0, true)
            driveCamera(tracked, now - lastCameraFrame, applyCameraParameter)
            lastCameraFrame = now
          }
          if (speakingRef.current) {
            const value = 0.2 + Math.abs(Math.sin(performance.now() / 110)) * 0.65
            for (const p of lips)
              core.setParameterValueByIndex(p.index, p.minimum + (p.maximum - p.minimum) * value)
          }
        })
        // 缩略图模式不绑定鼠标交互，避免多个预览争抢焦点。
        if (!miniature) {
          canvas.style.cursor = 'pointer'
          canvas.setAttribute('aria-label', 'Live2D 角色，点击播放动作，移动指针让角色看向你')
          let down: { x: number; y: number; id: number } | undefined
          const options = { signal: listeners.signal }
          canvas.addEventListener(
            'pointermove',
            (event) => {
              if (
                !pixi ||
                (driveCamera && cameraSample && currentCameraSample(cameraSample.current, performance.now()))
              ) return
              // 将画布坐标换算到 pixi 屏幕坐标，驱动角色视线跟随。
              const rect = canvas.getBoundingClientRect()
              live.focus(
                ((event.clientX - rect.left) / rect.width) * pixi.screen.width,
                ((event.clientY - rect.top) / rect.height) * pixi.screen.height,
              )
            },
            options,
          )
          canvas.addEventListener(
            'pointerleave',
            () => {
              down = undefined
              internal.focusController.focus(0, 0)
            },
            options,
          )
          canvas.addEventListener(
            'pointerdown',
            (event) => {
              if (event.button === 0 && event.isPrimary)
                down = { x: event.clientX, y: event.clientY, id: event.pointerId }
            },
            options,
          )
          canvas.addEventListener(
            'pointerup',
            (event) => {
              // 位移小于 8px 才视为点击，避免拖拽误触发动作。
              if (
                down &&
                down.id === event.pointerId &&
                Math.hypot(event.clientX - down.x, event.clientY - down.y) < 8
              )
                void playMotion()
              down = undefined
            },
            options,
          )
          canvas.addEventListener('pointercancel', () => (down = undefined), options)
        }
        setLoaded(true)
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message)
          capabilities.current = emptyCapabilities()
          callbacks.current.onCapabilitiesChange?.(capabilities.current)
          pixi?.destroy(true, { children: true, texture: false, baseTexture: false })
          pixi = undefined
        }
      }
    }
    void start()
    // 清理顺序：作废异步结果与版本号 → 移除事件/观察者 → 清空引用 → 销毁 pixi。
    return () => {
      cancelled = true
      ++motionVersion.current
      ++expressionVersion.current
      listeners.abort()
      observer?.disconnect()
      model.current = null
      capabilities.current = emptyCapabilities()
      callbacks.current.onCapabilitiesChange?.(capabilities.current)
      layoutRef.current = () => {}
      pixi?.destroy(true, { children: true, texture: false, baseTexture: false })
    }
  }, [path, miniature, isolated, revision, cameraSample])
  // 缩放变化时只重排布局，不重建模型。
  useEffect(() => {
    layoutRef.current()
  }, [zoom])
  // 表情或 revision 变化时重新应用情绪（加载完成后也会触发一次）。
  useEffect(() => {
    if (!isolated) applyMood(expression)
  }, [expression, expressionRevision, loaded, isolated])
  return (
    <div className="live2d-host" ref={host}>
      {!loaded && !error && (
        <div className="canvas-state">
          <LoaderCircle className="spin" size={22} />
          <span>正在唤醒你的伙伴…</span>
        </div>
      )}
      {error && (
        <div className="canvas-state error">
          <AlertCircle size={24} />
          <span>角色加载失败</span>
          <small>{error}</small>
          <button className="button ghost" onClick={() => setRevision((n) => n + 1)}>
            <RotateCcw size={15} />
            重新加载
          </button>
        </div>
      )}
    </div>
  )
})

export default Live2DStage
