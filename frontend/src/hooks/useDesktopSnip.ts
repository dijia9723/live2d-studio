import { useEffect, useRef, useState } from 'react'
import type { DesktopHandoff } from '../types/api'

export interface DesktopSnip {
  image?: string
  watch_id?: string
  width: number
  height: number
}

type NativeCall<T> = Promise<T> & { cancel(): void }
type WailsRuntime = { Call: { ByName<T>(name: string, ...args: unknown[]): NativeCall<T> } }
const runtimeURL = '/wails/runtime.js'

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

export function supportsDesktopSnip(desktop: boolean) {
  const host = window as Window & { __STUDIO_API_BASE_URL__?: string }
  return desktop && !!host.__STUDIO_API_BASE_URL__ && /Windows/i.test(navigator.userAgent)
}

export function useDesktopSnip(desktop: boolean) {
  const available = supportsDesktopSnip(desktop)
  const [capturing, setCapturing] = useState(false)
  const inFlight = useRef<AbortController | null>(null)
  useEffect(() => () => inFlight.current?.abort(), [])

  const capture = async (handoff: DesktopHandoff) => {
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
