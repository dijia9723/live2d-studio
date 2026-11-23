/**
 * 文件职责：桌面端屏幕截取/框选 Hook。
 * 通过 Wails 运行时调用原生 ScreenCapture 服务，获取框选图片或持续截图，
 * 用于「贴图对话」与屏幕观察；仅 Windows 桌面端可用。
 */
import { useEffect, useRef, useState } from 'react'
import type { DesktopHandoff } from '../types/api'

/** 一次框选结果；image 为 data URL，watch_id 可继续用于持续截帧。 */
export interface DesktopSnip {
  image?: string
  watch_id?: string
  width: number
  height: number
}

type NativeCall<T> = Promise<T> & { cancel(): void }
type WailsRuntime = { Call: { ByName<T>(name: string, ...args: unknown[]): NativeCall<T> } }
const runtimeURL = '/wails/runtime.js'

/**
 * 调用原生 ScreenCapture 服务的方法。
 * 原生调用无法直接取消，这里用 AbortSignal 桥接 call.cancel()，
 * 让组件卸载或用户取消时能立即关闭原生选择框。
 */
export async function callScreenCapture<T>(method: string, args: unknown[], signal?: AbortSignal) {
  const { Call } = (await import(/* @vite-ignore */ runtimeURL)) as WailsRuntime
  signal?.throwIfAborted()
  const call = Call.ByName<T>(`server/app.ScreenCapture.${method}`, ...args)
  const cancel = () => call.cancel()
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    return await call
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

/** 判断当前环境是否支持桌面框选：需桌面端、注入的服务地址且系统为 Windows。 */
export function supportsDesktopSnip(desktop: boolean) {
  const host = window as Window & { __STUDIO_API_BASE_URL__?: string }
  return desktop && !!host.__STUDIO_API_BASE_URL__ && /Windows/i.test(navigator.userAgent)
}

/**
 * 提供桌面框选能力。
 * @param desktop 是否为桌面客户端
 * @returns available：是否支持；capturing：是否正在框选；capture：发起一次框选
 */
export function useDesktopSnip(desktop: boolean) {
  const available = supportsDesktopSnip(desktop)
  const [capturing, setCapturing] = useState(false)
  const inFlight = useRef<AbortController | null>(null)
  // 组件卸载时取消尚未完成的框选，避免遗留原生遮罩和回调。
  useEffect(() => () => inFlight.current?.abort(), [])

  const capture = async (handoff: DesktopHandoff) => {
    // 同一时间只允许一个原生框选流程，重复点击会叠加遮罩。
    if (!available || inFlight.current) return null
    const controller = new AbortController()
    const { signal } = controller
    inFlight.current = controller
    setCapturing(true)
    try {
      const result = await callScreenCapture<DesktopSnip | null>('Snip', [handoff], signal)
      return signal.aborted ? null : result
    } catch (error) {
      if (signal.aborted) return null
      throw error
    } finally {
      inFlight.current = null
      if (!signal.aborted) setCapturing(false)
    }
  }

  return { available, capturing, capture }
}
