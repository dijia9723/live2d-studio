/**
 * 文件职责：角色卡片/详情中的 Live2D 静态预览。
 * 加载模型并挂到共享渲染器上，处理加载中、失败重试与卸载回收。
 */
import { useEffect, useRef, useState } from 'react'
import { AlertCircle, LoaderCircle, RotateCcw } from 'lucide-react'
import type { Live2DModel } from 'pixi-live2d-display'
import type { CharacterPreviewRenderer } from '../../utils/characterPreviewRenderer'
import { loadLive2DRuntime } from '../../utils/live2dRuntime'

/**
 * 角色预览。
 * @param modelPath 模型清单或 ZIP 的地址
 * @param renderer 多个卡片共享的预览渲染器
 */
export default function CharacterPreview({
  modelPath,
  renderer,
}: {
  modelPath: string
  renderer: CharacterPreviewRenderer
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const target = canvas.current
    if (!target) return
    let cancelled = false
    let model: Live2DModel | undefined
    let detach: (() => void) | undefined
    setReady(false)
    setError('')

    const release = () => {
      // 已挂到渲染器时由 detach 负责移除；尚未挂载则直接交给渲染器回收。
      if (detach) detach()
      else if (model) renderer.release(model)
      detach = undefined
      model = undefined
    }
    const fail = (cause: unknown) => {
      release()
      if (!cancelled) setError(cause instanceof Error ? cause.message : '角色加载失败')
    }

    const load = async () => {
      try {
        const { Live2DModel } = await loadLive2DRuntime(modelPath)
        // 加载是异步的，期间组件可能已卸载或模型路径已切换，必须丢弃结果。
        if (cancelled) return
        model = await Live2DModel.from(modelPath, { autoInteract: false, autoUpdate: false })
        if (cancelled) {
          release()
          return
        }
        detach = renderer.attach(target, model, () => setReady(true), fail)
      } catch (cause) {
        fail(cause)
      }
    }
    void load()
    return () => {
      cancelled = true
      release()
    }
  }, [modelPath, renderer, revision])

  return (
    <div className="live2d-host character-preview-host">
      <canvas
        ref={canvas}
        style={{ visibility: ready && !error ? 'visible' : 'hidden' }}
        aria-hidden="true"
      />
      {!ready && !error && (
        <div className="canvas-state" role="status">
          <LoaderCircle className="spin" size={22} />
          <span>正在加载角色…</span>
        </div>
      )}
      {error && (
        <div className="canvas-state error">
          <AlertCircle size={24} />
          <span>角色加载失败</span>
          <small>{error}</small>
          <button className="button ghost" onClick={() => setRevision((value) => value + 1)}>
            <RotateCcw size={15} />
            重新加载
          </button>
        </div>
      )}
    </div>
  )
}
