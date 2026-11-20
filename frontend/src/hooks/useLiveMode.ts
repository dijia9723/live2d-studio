import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { liveAPI } from '../api/live'
import type { LiveConfig, LiveKind, LiveMode, LiveState } from '../api/live'
import type { Live2DStageHandle } from '../components/Live2DStage'
import type { Character } from '../types/api'

interface Options {
  selected: boolean
  character?: Character
  stage: RefObject<Live2DStageHandle | null>
  chatBusy: boolean
  speaking: boolean
  speak: (text: string) => Promise<void>
  stopSpeaking: () => void
}

export function useLiveMode({
  selected,
  character,
  stage,
  chatBusy,
  speaking,
  speak,
  stopSpeaking,
}: Options) {
  const [state, setState] = useState<LiveState>()
  const [form, setForm] = useState<LiveConfig>()
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [offline, setOffline] = useState(false)
  const mounted = useRef(false)
  const command = useRef(false)
  const revision = useRef(0)
  const applied = useRef<{ session: string; reply: number }>(undefined)
  const attempted = useRef<LiveState>(undefined)
  const preparingSpeech = useRef(false)
  const last = state?.replies?.at(-1)
  const sameCharacter = state?.config.character_id === character?.id
  const polling = selected || !!state?.running
  const ready = state?.running && sameCharacter && state.config.mode !== 'paused'

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      const version = revision.current
      try {
        const snapshot = await liveAPI.state(abort.signal)
        if (abort.signal.aborted || revision.current !== version || command.current) return
        setState(snapshot)
        setOffline(false)
        setForm((current) => current ?? snapshot.config)
      } catch {
        if (!abort.signal.aborted) setOffline(true)
      } finally {
        if (polling && !abort.signal.aborted) {
          timer = setTimeout(() => void poll(), document.hidden ? 3000 : 1000)
        }
      }
    }
    void poll()
    return () => {
      abort.abort()
      clearTimeout(timer)
    }
  }, [polling])

  const run = useCallback(async (work: () => Promise<LiveState>) => {
    if (command.current) return
    command.current = true
    revision.current += 1
    setWorking(true)
    setError('')
    try {
      const snapshot = await work()
      if (mounted.current) {
        setState(snapshot)
        setOffline(false)
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '直播操作失败')
    } finally {
      command.current = false
      if (mounted.current) setWorking(false)
    }
  }, [])

  useEffect(() => {
    if (!state) return
    const reply = last?.id ?? 0
    const previous = applied.current
    if (previous?.session !== state.session_id) {
      applied.current = { session: state.session_id, reply }
      return
    }
    if (reply <= previous.reply || !last || !ready || chatBusy || speaking) return
    applied.current = { session: state.session_id, reply }
    if (last.error) return
    if (state.config.actions && character) {
      const model = stage.current
      if (last.expression) model?.setMood(last.expression)
      for (const item of last.stage ?? []) {
        if (item.character_id !== character.id || item.model_path !== character.model_path) continue
        if (item.type === 'motion') void model?.playMotion(item.id)
        if (item.type === 'expression') void model?.setExpression(item.id)
      }
    }
    if (state.config.speak && last.text) {
      preparingSpeech.current = true
      void speak(last.text).finally(() => {
        preparingSpeech.current = false
      })
    }
  }, [character, chatBusy, last, ready, speak, speaking, stage, state])

  const canReply = !!ready && !chatBusy && !speaking && !offline && !working && !state?.busy
  useEffect(() => {
    if (!state?.auto_ready || state === attempted.current || !canReply || preparingSpeech.current)
      return
    attempted.current = state
    void run(async () => (await liveAPI.reply(state.session_id)).state)
  }, [canReply, run, state])

  function save(start?: 'demo' | 'real') {
    if (!form || !character) return
    const characterID = state?.running ? state.config.character_id : character.id
    void run(async () => {
      const saved = await liveAPI.save({ ...form, character_id: characterID })
      if (mounted.current) setForm(saved.config)
      if (!saved.config.speak) stopSpeaking()
      return start ? liveAPI.start(start === 'demo') : saved
    })
  }

  function setMode(mode: LiveMode) {
    if (!state || state.config.mode === mode) return
    void run(async () => {
      const saved = await liveAPI.save({ ...state.config, mode })
      if (mounted.current) setForm((current) => current && { ...current, mode })
      if (mode === 'paused') stopSpeaking()
      return saved
    })
  }

  return {
    state,
    form,
    setForm,
    working,
    error: error || state?.error || (offline ? '暂时无法读取直播状态，正在重试' : ''),
    dirty: !!form && !!state && JSON.stringify(form) !== JSON.stringify(state.config),
    caption: ready && !chatBusy ? state?.draft || (last?.error ? '' : last?.text) : '',
    canReply,
    save,
    setMode,
    stop: () => {
      stopSpeaking()
      void run(liveAPI.stop)
    },
    reply: (id: number) => {
      if (!state || !canReply || preparingSpeech.current) return
      void run(async () => (await liveAPI.reply(state.session_id, id)).state)
    },
    demoEvent: (kind: LiveKind) => void run(() => liveAPI.demoEvent(kind)),
  }
}
