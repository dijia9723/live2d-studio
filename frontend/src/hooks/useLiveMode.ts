/**
 * 文件职责：直播陪伴状态的 Hook。
 * 轮询后端直播快照、维护本地表单、执行启动/停止/切换模式等命令，
 * 并在新的 AI 回复到达时驱动角色动作与朗读。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { liveAPI } from '../api/live'
import type { LiveConfig, LiveMode, LiveState } from '../api/live'
import type { Live2DStageHandle } from '../components/stage/Live2DStage'
import type { Character } from '../types/api'

/** useLiveMode 的外部依赖。 */
interface Options {
  selected: boolean
  character?: Character
  stage: RefObject<Live2DStageHandle | null>
  chatBusy: boolean
  speaking: boolean
  speak: (text: string) => Promise<void>
  stopSpeaking: () => void
}

/**
 * 管理直播面板的数据与操作。
 * @param selected 当前是否进入直播页，决定是否保持轮询
 * @returns state/form/working/error 等展示状态，以及 save/start/stop/setMode/reply 等操作
 */
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
  // 只有进入直播页或直播正在运行时才轮询，避免后台常驻请求。
  const polling = selected || !!state?.running
  const ready = state?.running && !!state.recording_id && sameCharacter && state.config.mode !== 'paused'

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
        // 命令执行期间或其后的旧快照会覆盖新状态，按 revision 丢弃。
        if (abort.signal.aborted || revision.current !== version || command.current) return
        setState(snapshot)
        setOffline(false)
        setForm((current) => current ?? snapshot.config)
      } catch {
        if (!abort.signal.aborted) setOffline(true)
      } finally {
        // 页面隐藏时降频，减少不可见状态下的无意义请求。
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

  // 所有写操作串行执行：命令期间 poll 会被标记跳过，避免状态互相覆盖。
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
    // 新场次的回复编号会从 0 重新开始，先记录基线而不触发旧回复。
    if (previous?.session !== state.session_id) {
      applied.current = { session: state.session_id, reply }
      return
    }
    // 同一条回复只应用一次，轮询重复到达时不再重播动作或朗读。
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
    // attempted 记录已经发起过自动回应的快照，防止同一批事件被重复自动回应。
    if (!state?.auto_ready || state === attempted.current || !canReply || preparingSpeech.current)
      return
    attempted.current = state
    void run(async () => (await liveAPI.reply(state.session_id)).state)
  }, [canReply, run, state])

  function save(start = false) {
    if (!form || !character) return
    // 直播进行中不允许换角色，沿用后端当前配置的角色 ID。
    const characterID = state?.running ? state.config.character_id : character.id
    void run(async () => {
      const saved = await liveAPI.save({ ...form, character_id: characterID })
      if (mounted.current) setForm(saved.config)
      if (!saved.config.speak) stopSpeaking()
      return start ? liveAPI.start() : saved
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
    save: () => save(),
    start: () => save(true),
    setMode,
    stop: () => {
      stopSpeaking()
      void run(liveAPI.stop)
    },
    reply: (id: number) => {
      if (!state || !canReply || preparingSpeech.current) return
      void run(async () => (await liveAPI.reply(state.session_id, id)).state)
    },
  }
}
