/**
 * 文件职责：屏幕观察 Hook。
 * 以固定节奏采集屏幕/窗口画面，用本地 PaddleOCR 识别文字并跟踪变化，
 * 在对话提问时生成屏幕上下文（文字摘要 + 必要时裁图）供模型理解。
 */
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
  fullScreen,
  mergeScreenLines,
  pointedQuestion,
  screenQuestionIntent,
  screenSampler,
  needsScreenImage,
} from '../utils/screenObservation'
import type { ScreenLine, ScreenPoint, ScreenRect } from '../utils/screenObservation'

interface WatchFrame {
  image?: string
  pointer?: ScreenPoint
}

/** 画面来源：窗口视频流或桌面端持续截帧，统一成 next()/close() 协议。 */
interface WatchSource {
  next(signal: AbortSignal): Promise<CanvasImageSource | null>
  pointer?: ScreenPoint
  close(): void
}

type Scope = { character: string; conversation: string | null }
type Stats = {
  phase: 'starting' | 'watching' | 'paused'
  scans: number
  elapsed?: number
  changes?: string[]
  preview?: string[]
}

/** 一次观看会话的完整运行态，关闭时统一通过 controller 与 source 释放。 */
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
  lastChange?: ScreenRect
  pendingArea?: ScreenRect
  recognized?: Uint8ClampedArray
  lastTurn?: { question: string; evidence: string; acceptedAt: number }
  refresh(readText: boolean, signal: AbortSignal): Promise<void>
}

// 提问时最多等待这么久刷新画面，保证交互不被 OCR 拖住。
const questionRefreshMs = 520
// 追问窗口：上一轮屏幕问答在该时间内才作为“历史线索”带入。
const screenFollowUpMs = 120_000

/** 加载本地 PaddleOCR；截图文字只在本机推理，不上传。 */
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
      // 开发环境使用同源的 worker 文件；打包环境交给库自己创建 worker。
      ? { createWorker: () => new Worker(assets + 'worker.mjs', { type: 'module' }) }
      : true,
    ortOptions: { backend: 'wasm', wasmPaths: assets, numThreads: 1 },
  })
}

/** 对裁图执行 OCR，并把归一化坐标换算回整屏的归一化区域。 */
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

/** 桌面端持续截帧来源：通过原生 watch_id 拉取最新画面与鼠标位置。 */
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

/**
 * 管理屏幕观察的采集、识别与提问上下文。
 * @param character 当前角色 ID，切换角色时停止观察
 * @param conversation 当前会话 ID；null 表示尚未创建会话
 * @returns stats/error 展示状态，region/windowSource 开始观察，
 *          togglePause/stop 控制运行，prepareQuestion/finishQuestion 生成提问上下文
 */
export function useScreenWatch(character: string, conversation: string | null) {
  const scope = useRef<Scope>({ character, conversation })
  scope.current = { character, conversation }
  const session = useRef<WatchSession | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState('')
  const windowRequest = useRef<AbortController | null>(null)

  // 统一释放：取消进行中的窗口授权、停止采集流、结束 OCR 引擎。
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

  useEffect(() => {
    // 页面隐藏/卸载时媒体流不会自动关闭，需主动释放。
    window.addEventListener('pagehide', dispose)
    return () => {
      window.removeEventListener('pagehide', dispose)
      dispose()
    }
  }, [dispose])
  useEffect(() => {
    const active = session.current
    if (!active) {
      if (windowRequest.current) stop()
      return
    }
    if (active.scope.character === character) {
      if (active.scope.conversation === conversation) return
      // 首条消息发出时才创建会话：允许把草稿阶段的观察无缝迁移到新会话。
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
      async refresh(readText, request) {
        await readLatest()
        if (!readText || request.aborted) return
        await scanLatest()
        if (!request.aborted && active.pendingArea) await scanLatest()
      },
    }
    session.current = active
    let latest: Uint8ClampedArray | undefined
    let lastMotion = 0
    let lastScan = 0
    let capture: Promise<void> | undefined
    let recognition: Promise<void> | undefined
    let revision = 0
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
        // 中止时清掉定时器并释放 OCR 的 wasm/worker 资源。
        clearTimeout(timer)
        void engine.then((ocr) => ocr.dispose()).catch(() => {})
      },
      { once: true },
    )

    async function readFrame() {
      try {
        if (active.paused) return
        const picture = await source.next(signal)
        if (signal.aborted || active.paused) return
        const now = performance.now()
        if (!picture) return
        const width =
          picture instanceof HTMLVideoElement
            ? picture.videoWidth
            : (picture as HTMLImageElement).width
        const height =
          picture instanceof HTMLVideoElement
            ? picture.videoHeight
            : (picture as HTMLImageElement).height
        // 长边限制在 1600 像素内，兼顾 OCR 精度与逐帧采样的开销。
        const scale = Math.min(1, 1600 / Math.max(width, height))
        const w = Math.max(1, Math.round(width * scale))
        const h = Math.max(1, Math.round(height * scale))
        if (frame.width !== w || frame.height !== h) {
          frame.width = w
          frame.height = h
          active.recognized = undefined
          latest = undefined
          revision += 1
        }
        painter.drawImage(picture, 0, 0, w, h)
        active.hasFrame = true
        const signature = sample(frame)
        // 用低分辨率指纹判断画面是否变化，只对变化区域重新 OCR。
        if (changedScreenArea(latest, signature)) {
          latest = signature
          lastMotion = now
          active.pendingArea = changedScreenArea(active.recognized, signature) ?? undefined
        }
      } catch (cause) {
        fail(cause)
      }
    }

    function readLatest() {
      return (capture ??= readFrame().finally(() => {
        capture = undefined
      }))
    }

    function scanLatest() {
      // 同一时刻只跑一次识别，避免定时器与提问刷新重复推理。
      if (recognition) return recognition
      const input = latest
      const area = active.pendingArea
      if (!input || !area || signal.aborted || active.paused) return
      const frameRevision = revision
      const crop = cropScreen(frame, area, 1536)
      lastScan = performance.now()
      recognition = engine
        .then(async (ocr) => {
          // 识别期间画面或会话可能已变化，结果过期就丢弃，避免把旧文字写回。
          if (signal.aborted || active.paused || revision !== frameRevision) return
          const started = performance.now()
          const lines = await readScreen(ocr, crop, area)
          if (signal.aborted || active.paused || revision !== frameRevision) return
          const next = mergeScreenLines(active.lines, lines, area)
          const change = active.recognized && describeScreenChange(active.lines, next)
          if (change)
            active.changes = [change, ...active.changes.filter((item) => item !== change)].slice(
              0,
              8,
            )
          active.lines = next
          active.recognized = input
          active.lastChange = area
          active.pendingArea = latest ? (changedScreenArea(input, latest) ?? undefined) : undefined
          setStats(
            (previous) =>
              previous && {
                phase: 'watching',
                scans: previous.scans + 1,
                elapsed: Math.round(performance.now() - started),
                changes: active.changes,
                preview: next.slice(0, 4).map(({ text }) => text),
              },
          )
        })
        .catch(fail)
        .finally(() => {
          recognition = undefined
        })
      return recognition
    }

    async function tick() {
      await readLatest()
      if (signal.aborted) return
      const now = performance.now()
      // 画面有变化或距上次扫描过久才重新识别，避免每个心跳都跑 OCR；暂停时 scanLatest 会直接返回。
      if (!active.recognized || now - lastMotion >= 240 || now - lastScan >= 1400) {
        void scanLatest()
      }
      timer = setTimeout(() => void tick(), active.paused ? 450 : 160)
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
        // 只申请窗口画面并限制帧率，降低采样负担。
        video: { displaySurface: 'window', frameRate: { ideal: 5, max: 8 } },
      })
      const close = () => stream.getTracks().forEach((track) => track.stop())
      if (request.signal.aborted) return close()
      windowRequest.current = null
      const video = document.createElement('video')
      video.srcObject = stream
      video.muted = true
      video.playsInline = true
      // 用户直接从系统取消/关闭共享时，同样回到停止状态。
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

  async function prepareQuestion(
    question: string,
    visionAvailable: boolean,
    forceImage: boolean,
    signal: AbortSignal,
  ) {
    const active = session.current
    const inScope = () =>
      active?.scope.character === scope.current.character &&
      active.scope.conversation === scope.current.conversation
    if (!active || !inScope()) return undefined
    // 草稿阶段（conversation 为 null）提问后要等会话创建完成再绑定。
    active.bindDraft = active.scope.conversation === null
    const lastTurn = active.lastTurn
    const prior =
      lastTurn && Date.now() - lastTurn.acceptedAt <= screenFollowUpMs ? lastTurn : undefined
    const intent = screenQuestionIntent(question, !!prior)
    if (active.paused || (!intent && !forceImage)) {
      return {
        observation: undefined,
        accept: () => {
          if (session.current === active) active.lastTurn = undefined
        },
      }
    }
    const visual =
      visionAvailable && (forceImage || (intent !== 'recent' && needsScreenImage(question)))
    const request = AbortSignal.any([
      signal,
      active.controller.signal,
      // 刷新有上限，超时就用最近一次完成的识别结果回答。
      AbortSignal.timeout(questionRefreshMs),
    ])
    let sampled = false
    const untilAborted = new Promise<void>((resolve) => {
      if (request.aborted) resolve()
      else request.addEventListener('abort', () => resolve(), { once: true })
    })
    await Promise.race([
      active.refresh(!visual, request).then(() => {
        sampled = true
      }),
      untilAborted,
    ])
    if (signal.aborted || session.current !== active || !inScope() || active.paused)
      return undefined
    const point = pointedQuestion.test(question) ? active.source.pointer : undefined
    const evidence = describeScreen(active.lines, active.changes, question, point)
    const observation: ScreenContext = {
      text: active.recognized
        ? active.pendingArea || !sampled
          ? `正在核对画面，下方为最近一次完成的识别。\n${evidence}`
          : evidence
        : '屏幕正在识别，当前没有可用的文字结果。',
    }
    if (intent === 'follow-up' && prior) {
      observation.text += `\n上次屏幕问题（历史线索）：${prior.question}`
      if (prior.evidence) observation.text += `\n上次屏幕识别：${prior.evidence}`
    }
    if (
      active.hasFrame &&
      visionAvailable &&
      (visual || (intent === 'current' && !active.lines.length))
    ) {
      observation.image = cropScreen(
        active.frame,
        forceImage ? fullScreen : focusArea(point, active.pendingArea ?? active.lastChange),
        960,
      ).toDataURL('image/jpeg', 0.82)
    }
    return {
      observation,
      accept: () => {
        if (session.current !== active || active.paused) return
        active.lastTurn = {
          question:
            intent === 'follow-up' && prior ? prior.question : question.trim().slice(0, 120),
          evidence:
            intent === 'follow-up' && prior
              ? prior.evidence
              : active.recognized
                ? evidence.slice(0, 240)
                : '',
          acceptedAt: Date.now(),
        }
      },
    }
  }

  function finishQuestion(owner: Scope) {
    const active = session.current
    // 只有草稿阶段提问的会话才需要接管；已绑定会话保持原 scope。
    if (!active?.bindDraft) return
    active.bindDraft = false
    if (active.scope.character === owner.character && active.scope.conversation === null) {
      active.scope = owner
    }
  }

  return { stats, error, region, windowSource, togglePause, stop, prepareQuestion, finishQuestion }
}
