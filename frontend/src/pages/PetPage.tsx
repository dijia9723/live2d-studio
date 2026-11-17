import { useCallback, useEffect, useState } from 'react'
import { ArrowUp, GripHorizontal, Square, Volume2, X } from 'lucide-react'
import Live2DStage from '../components/Live2DStage'
import { useStudio } from '../store/studio'
import { api } from '../api/client'
import { useChat } from '../hooks/useChat'
import { useSpeech } from '../hooks/useSpeech'

export default function PetPage() {
  const s = useStudio()
  const [text, setText] = useState('')
  const [bubble, setBubble] = useState('今天也要好好照顾自己呀。')
  const char = s.characters.find((c) => c.id === s.characterID) || s.characters[0]
  const transcript = useCallback((t: string) => setText(t), [])
  const interrupt = useCallback(() => {}, [])
  const voice = useSpeech(transcript, interrupt)
  const chat = useChat((t) => {
    setBubble(t)
    if (useStudio.getState().speechEnabled) void voice.speak(t)
  })
  useEffect(() => {
    document.documentElement.classList.add('pet-document')
    return () => document.documentElement.classList.remove('pet-document')
  }, [])
  useEffect(() => {
    const sync = (e: StorageEvent) => {
      if (e.key === 'live2d-studio-preferences') {
        const before = useStudio.getState().characterID
        void Promise.resolve(useStudio.persist.rehydrate()).then(() => {
          const state = useStudio.getState()
          if (state.characterID !== before) {
            chat.stop()
            voice.stopSpeaking()
            state.selectCharacter(state.characterID)
          }
        })
      }
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])
  return (
    <div className="pet-page">
      <div className="pet-toolbar">
        <span className="pet-drag" style={{ '--wails-draggable': 'drag' } as React.CSSProperties}>
          <GripHorizontal size={17} />
          {char?.name}
        </span>
        <button
          title="关闭桌宠"
          onClick={() => {
            chat.stop()
            voice.stopSpeaking()
            void api.window('pet', false)
          }}
        >
          <X size={17} />
        </button>
      </div>
      <div
        className={`pet-bubble ${s.chatError ? 'pet-error' : ''}`}
        role={s.chatError ? 'alert' : undefined}
      >
        {s.busy ? s.messages.at(-1)?.content || '让我想一想…' : s.chatError || bubble}
      </div>
      <div className="pet-model">{char && <Live2DStage modelPath={char.model_path} />}</div>
      <form
        className="pet-composer"
        onSubmit={(e) => {
          e.preventDefault()
          if (s.busy) {
            chat.stop()
            voice.stopSpeaking()
            return
          }
          voice.stopSpeaking()
          void chat.send(text)
          setText('')
        }}
      >
        <Volume2 size={15} />
        <input placeholder="和我说点什么…" value={text} onChange={(e) => setText(e.target.value)} />
        <button disabled={!s.busy && !text.trim()} aria-label={s.busy ? '停止生成' : '发送'}>
          {s.busy ? <Square size={13} /> : <ArrowUp size={17} />}
        </button>
      </form>
    </div>
  )
}
