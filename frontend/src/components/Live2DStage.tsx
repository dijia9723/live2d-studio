import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
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

export type { Live2DCapabilities } from '../utils/live2d'

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

const moodNames: Record<string, string> = {
  neutral: '自然',
  happy: '开心',
  sad: '难过',
  surprised: '惊讶',
}

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
        corePromise = undefined
        script.remove()
        reject(new Error('Cubism Core 加载失败，请检查本地运行库'))
      }
      document.head.appendChild(script)
    })
  return corePromise
}

interface Props {
  modelPath: string
  miniature?: boolean
  onCapabilitiesChange?: (capabilities: Live2DCapabilities) => void
  onInteraction?: (message: string) => void
}

const Live2DStage = forwardRef<Live2DStageHandle, Props>(function Live2DStage(
  { modelPath: path, miniature = false, onCapabilitiesChange, onInteraction },
  ref,
) {
  const host = useRef<HTMLDivElement>(null)
  const model = useRef<Live2DModel | null>(null)
  const capabilities = useRef(emptyCapabilities())
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [revision, setRevision] = useState(0)
  const zoom = useStudio((s) => s.zoom)
  const expression = useStudio((s) => s.expression)
  const expressionRevision = useStudio((s) => s.expressionRevision)
  const speaking = useStudio((s) => s.speaking)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const speakingRef = useRef(speaking)
  speakingRef.current = speaking
  const moodRef = useRef(expression)
  const nativeExpressionRef = useRef(false)
  const expressionVersion = useRef(0)
  const motionVersion = useRef(0)
  const layoutRef = useRef<() => void>(() => {})
  const callbacks = useRef({ onCapabilitiesChange, onInteraction })
  callbacks.current = { onCapabilitiesChange, onInteraction }
  const report = (message: string) => (callbacks.current.onInteraction || notify)(message)

  const applyMood = (mood: string) => {
    ++expressionVersion.current
    moodRef.current = mood
    nativeExpressionRef.current = false
    // Cancel pending loads so a slow native expression cannot replace a later mood.
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
      // FORCE alone rejects an already active motion; reset its reservation first.
      live.internalModel.motionManager.stopAllMotions()
      const started = await live.motion(motion.group, motion.index, 3)
      if (model.current !== live || version !== motionVersion.current) return false
      report(
        started ? `正在播放：${motion.label}` : `动作未能播放：${motion.label}，请检查模型资源`,
      )
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
      else report(`已切换为${moodNames[mood] || mood}表情`)
    },
    setExpression: async (name) => {
      const live = model.current
      if (!live || !capabilities.current.ready) {
        report('角色仍在加载，请稍后再试')
        return false
      }
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
        // The library returns false for an already active expression.
        if (!changed) manager.restoreExpression()
        const index = manager.getExpressionIndex(name)
        const available = changed || !!manager.expressions[index]
        if (!available) nativeExpressionRef.current = false
        report(available ? `已应用模型表情：${name}` : `表情加载失败：${name}`)
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
      model.current?.internalModel.focusController.focus(0, 0, true)
      report('已重置角色表情与动作')
    },
  }))

  useEffect(() => {
    const target = host.current
    if (!target) return
    let cancelled = false
    let pixi: Application | undefined
    let observer: ResizeObserver | undefined
    const listeners = new AbortController()
    capabilities.current = emptyCapabilities()
    callbacks.current.onCapabilitiesChange?.(capabilities.current)
    setLoaded(false)
    setError('')
    nativeExpressionRef.current = false
    const start = async () => {
      try {
        await loadCore()
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
        // Models can omit HitAreas, so pointer handling uses the canvas directly.
        const live = await Live2DModel.from(path, { autoInteract: false })
        if (cancelled) {
          live.destroy({ children: true, texture: false, baseTexture: false })
          return
        }
        model.current = live
        pixi.stage.addChild(live)
        const bounds = live.getLocalBounds()
        live.anchor.set(0.5, 0.5)
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
        // Converted models retain PARAM_* IDs for mouse following as well.
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
        internal.on('beforeModelUpdate', () => {
          if (miniature) return
          if (!nativeExpressionRef.current)
            for (const p of moodParameters(moodRef.current, bindings))
              core.setParameterValueByIndex(p.index, p.value)
          if (speakingRef.current) {
            const value = 0.2 + Math.abs(Math.sin(performance.now() / 110)) * 0.65
            for (const p of lips)
              core.setParameterValueByIndex(p.index, p.minimum + (p.maximum - p.minimum) * value)
          }
        })
        if (!miniature) {
          canvas.style.cursor = 'pointer'
          canvas.setAttribute('aria-label', 'Live2D 角色，点击播放动作，移动指针让角色看向你')
          let down: { x: number; y: number; id: number } | undefined
          const options = { signal: listeners.signal }
          canvas.addEventListener(
            'pointermove',
            (event) => {
              if (!pixi) return
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
  }, [path, miniature, revision])
  useEffect(() => {
    layoutRef.current()
  }, [zoom])
  useEffect(() => {
    applyMood(expression)
  }, [expression, expressionRevision, loaded])
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
