import { useCallback, useEffect, useRef, useState } from 'react'
import type { PaddleOCR } from '@paddleocr/paddleocr-js'
import type { ScreenContext } from '../types/api'
import { callScreenCapture } from './useDesktopSnip'
import {
  changedScreenArea,
  cropScreen,
  describeScreen,
  describeScreenChange,
  focusArea,
  mergeScreenLines,
  screenQuestion,
  screenSampler,
  visualQuestion,
} from '../utils/screenObservation'
import type { ScreenLine, ScreenPoint, ScreenRect } from '../utils/screenObservation'

interface WatchFrame {
  image?: string
  pointer?: ScreenPoint
}

interface WatchSource {
  next(signal: AbortSignal): Promise<CanvasImageSource | null>
  pointer?: ScreenPoint
  close(): void
}

type Scope = { character: string; conversation: string | null }
type Stats = { phase: 'starting' | 'watching' | 'paused'; scans: number; elapsed?: number }

interface WatchSession {
  scope: Scope
  source: WatchSource
  controller: AbortController
  frame: HTMLCanvasElement
  lines: ScreenLine[]
  changes: string[]
  bindDraft: boolean
  paused: boolean
  hasFrame: boolean
  updatedAt?: number
  lastChange?: ScreenRect
  recognized?: Uint8ClampedArray
}

async function startLocalOCR() {
  const { PaddleOCR } = await import('@paddleocr/paddleocr-js')
  const assets = new URL('/ocr/', window.location.href).href
  const detection = 'PP-OCRv6_tiny_det'
  const recognition = 'PP-OCRv6_tiny_rec'
  return PaddleOCR.create({
    textDetectionModelName: detection,
    textDetectionModelAsset: { url: assets + detection + '_onnx_infer.tar' },
    textRecognitionModelName: recognition,
    textRecognitionModelAsset: { url: assets + recognition + '_onnx_infer.tar' },
    worker: import.meta.env.DEV
      ? { createWorker: () => new Worker(assets + 'worker.mjs', { type: 'module' }) }
      : true,
    ortOptions: { backend: 'wasm', wasmPaths: assets, numThreads: 1 },
  })
}

async function readScreen(
  ocr: Pick<PaddleOCR, 'predict'>,
  crop: HTMLCanvasElement,
  area: ScreenRect,
): Promise<ScreenLine[]> {
  const [result] = await ocr.predict(crop, {
    textDetLimitSideLen: 1152,
    textDetLimitType: 'max',
    textRecScoreThresh: 0.58,
  })
  return (result?.items ?? []).flatMap(({ text, poly }) => {
    const left = Math.min(...poly.map(([x]) => x)) / crop.width
    const right = Math.max(...poly.map(([x]) => x)) / crop.width
    const top = Math.min(...poly.map(([, y]) => y)) / crop.height
    const bottom = Math.max(...poly.map(([, y]) => y)) / crop.height
    const line = text.replace(/\s+/g, ' ').trim()
    return line
      ? [
          {
            text: line.slice(0, 200),
            bounds: {
              x: area.x + left * area.w,
              y: area.y + top * area.h,
              w: (right - left) * area.w,
              h: (bottom - top) * area.h,
            },
          },
        ]
      : []
  })
}

function desktopRegion(id: string): WatchSource {
  return {
    async next(signal) {
      const update = await callScreenCapture<WatchFrame | null>('WatchFrame', [id], signal)
      if (update?.pointer) this.pointer = update.pointer
      if (!update?.image) return null
      const image = new Image()
      image.src = update.image
      await image.decode()
      return image
    },
    close() {
      void callScreenCapture('EndWatch', [id]).catch(() => {})
    },
  }
}

export function useScreenWatch(character: string, conversation: string | null) {
  const scope = useRef<Scope>({ character, conversation })
  scope.current = { character, conversation }
  const session = useRef<WatchSession | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState('')
  const windowRequest = useRef<AbortController | null>(null)

  const dispose = useCallback(() => {
    windowRequest.current?.abort()
    windowRequest.current = null
    const active = session.current
    session.current = null
    active?.controller.abort()
    active?.source.close()
  }, [])

  const stop = useCallback(() => {
    dispose()
    setStats(null)
    setError('')
  }, [dispose])

  useEffect(() => dispose, [dispose])
  useEffect(() => {
    const active = session.current
    if (!active) {
      if (windowRequest.current) stop()
      return
    }
    if (active.scope.character === character) {
      if (active.scope.conversation === conversation) return
      if (active.scope.conversation === null && conversation && active.bindDraft) {
        active.scope = { character, conversation }
        active.bindDraft = false
        return
      }
    }
    stop()
  }, [character, conversation, stop])

  function begin(source: WatchSource, owner: Scope) {
    dispose()
    setError('')
    setStats({ phase: 'starting', scans: 0 })
    const controller = new AbortController()
    const { signal } = controller
    const frame = document.createElement('canvas')
    const painter = frame.getContext('2d')!
    const sample = screenSampler()
    const active: WatchSession = {
      scope: owner,
      source,
      controller,
      frame,
      lines: [],
      changes: [],
      bindDraft: false,
      paused: false,
      hasFrame: false,
    }
    session.current = active
    let latest: Uint8ClampedArray | undefined
    let lastMotion = 0
    let lastScan = 0
    let working = false
    let timer: ReturnType<typeof setTimeout>
    const engine = startLocalOCR()
    const fail = (cause: unknown) => {
      if (signal.aborted) return
      dispose()
      setStats(null)
      setError(cause instanceof Error ? cause.message : '无法观看屏幕')
    }
    void engine.catch(() => fail(new Error('无法启动内置 OCR，请检查客户端资源是否完整')))
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        void engine.then((ocr) => ocr.dispose()).catch(() => {})
      },
      { once: true },
    )

    async function tick() {
      try {
        if (active.paused) return
        const picture = await source.next(signal)
        if (signal.aborted || active.paused) return
        const now = performance.now()
        if (picture) {
          const width =
            picture instanceof HTMLVideoElement
              ? picture.videoWidth
              : (picture as HTMLImageElement).width
          const height =
            picture instanceof HTMLVideoElement
              ? picture.videoHeight
              : (picture as HTMLImageElement).height
          const scale = Math.min(1, 1600 / Math.max(width, height))
          const w = Math.max(1, Math.round(width * scale))
          const h = Math.max(1, Math.round(height * scale))
          if (frame.width !== w || frame.height !== h) {
            frame.width = w
            frame.height = h
            active.recognized = undefined
          }
          painter.drawImage(picture, 0, 0, w, h)
          active.hasFrame = true
          const signature = sample(frame)
          if (changedScreenArea(latest, signature)) {
            latest = signature
            lastMotion = now
          }
        }
        if (
          !latest ||
          working ||
          (active.recognized && now - lastMotion < 240 && now - lastScan < 1400)
        )
          return
        const area = changedScreenArea(active.recognized, latest)
        if (!area) return
        const input = latest
        const crop = cropScreen(frame, area, 1536)
        working = true
        lastScan = now
        void engine
          .then(async (ocr) => {
            if (signal.aborted || active.paused) return
            const started = performance.now()
            const lines = await readScreen(ocr, crop, area)
            if (signal.aborted || active.paused) return
            const next = mergeScreenLines(active.lines, lines, area)
            const change = active.recognized && describeScreenChange(active.lines, next)
            if (change)
              active.changes = [change, ...active.changes.filter((item) => item !== change)].slice(
                0,
                8,
              )
            active.lines = next
            active.recognized = input
            active.updatedAt = Date.now()
            active.lastChange = area
            setStats(
              (previous) =>
                previous && {
                  phase: 'watching',
                  scans: previous.scans + 1,
                  elapsed: Math.round(performance.now() - started),
                },
            )
          })
          .catch(fail)
          .finally(() => {
            working = false
          })
      } catch (cause) {
        fail(cause)
      } finally {
        if (!signal.aborted) timer = setTimeout(() => void tick(), active.paused ? 450 : 160)
      }
    }
    void tick()
  }

  function region(id: string, owner: Scope) {
    const source = desktopRegion(id)
    if (
      scope.current.character !== owner.character ||
      scope.current.conversation !== owner.conversation
    ) {
      source.close()
      return
    }
    begin(source, owner)
  }

  async function windowSource() {
    stop()
    const owner = scope.current
    const request = new AbortController()
    windowRequest.current = request
    setStats({ phase: 'starting', scans: 0 })
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: { displaySurface: 'window', frameRate: { ideal: 5, max: 8 } },
      })
      const close = () => stream.getTracks().forEach((track) => track.stop())
      if (request.signal.aborted) return close()
      windowRequest.current = null
      const video = document.createElement('video')
      video.srcObject = stream
      video.muted = true
      video.playsInline = true
      stream.getVideoTracks()[0]?.addEventListener('ended', stop, { once: true })
      begin(
        {
          async next() {
            if (video.paused) await video.play()
            return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ? video : null
          },
          close() {
            close()
            video.srcObject = null
          },
        },
        owner,
      )
    } catch (cause) {
      if (request.signal.aborted) return
      stop()
      if (!(
        cause instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(cause.name)
      )) {
        setError('无法观看窗口，可通过 Windows 截图工具框选区域')
      }
    }
  }

  function togglePause() {
    const active = session.current
    if (!active) return
    active.paused = !active.paused
    setStats(
      (previous) =>
        previous && {
          ...previous,
          phase: active.paused ? 'paused' : active.recognized ? 'watching' : 'starting',
        },
    )
  }

  function contextFor(question: string, visionAvailable: boolean, forceImage: boolean) {
    const active = session.current
    if (!active) return undefined
    active.bindDraft = active.scope.conversation === null
    if (active.paused || (!screenQuestion.test(question) && !forceImage)) return undefined
    const observation: ScreenContext = {
      text: active.recognized
        ? `OCR 结果距今 ${Math.max(0, Math.round((Date.now() - (active.updatedAt ?? Date.now())) / 1000))} 秒。\n${describeScreen(active.lines, active.changes, question, active.source.pointer)}`
        : '屏幕正在识别，当前没有可用的文字结果。',
    }
    if (
      active.hasFrame &&
      visionAvailable &&
      (forceImage || visualQuestion.test(question) || !active.lines.length)
    ) {
      observation.image = cropScreen(
        active.frame,
        focusArea(active.source.pointer, active.lastChange),
        960,
      ).toDataURL('image/jpeg', 0.82)
    }
    return observation
  }

  function finishQuestion(owner: Scope) {
    const active = session.current
    if (!active?.bindDraft) return
    active.bindDraft = false
    if (active.scope.character === owner.character && active.scope.conversation === null) {
      active.scope = owner
    }
  }

  return { stats, error, region, windowSource, togglePause, stop, contextFor, finishQuestion }
}
