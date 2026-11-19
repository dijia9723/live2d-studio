import { useEffect, useRef, useState } from 'react'
import { AlertCircle, LoaderCircle, RotateCcw } from 'lucide-react'
import type { Live2DModel } from 'pixi-live2d-display'
import type { CharacterPreviewRenderer } from '../utils/characterPreviewRenderer'
import { loadLive2DRuntime } from '../utils/live2dRuntime'

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
