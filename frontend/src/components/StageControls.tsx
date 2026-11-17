import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Play, RotateCcw, Shuffle } from 'lucide-react'
import type { Live2DCapabilities, Live2DStageHandle } from './Live2DStage'
import { useStudio } from '../store/studio'
import '../assets/character-controls.css'

const moods = [
  { key: 'neutral', label: '自然' },
  { key: 'happy', label: '开心' },
  { key: 'sad', label: '难过' },
  { key: 'surprised', label: '惊讶' },
]

function MoodFace({ mood }: { mood: string }) {
  return (
    <svg
      className={`character-mood-face character-mood-face-${mood}`}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <circle className="character-face-outline" cx="20" cy="20" r="16" />
      {mood === 'happy' ? (
        <>
          <path d="M11.5 17.5c1.5-2.5 3.5-2.5 5 0M23.5 17.5c1.5-2.5 3.5-2.5 5 0" />
          <path d="M14.5 23c1.6 5 9.4 5 11 0" />
          <ellipse className="character-face-blush" cx="11.5" cy="23" rx="2.5" ry="1.5" />
          <ellipse className="character-face-blush" cx="28.5" cy="23" rx="2.5" ry="1.5" />
        </>
      ) : mood === 'sad' ? (
        <>
          <path d="m11.5 15 5-2m7 0 5 2M15.5 26c2-3 7-3 9 0" />
          <circle cx="14" cy="18.5" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="26" cy="18.5" r="1.2" fill="currentColor" stroke="none" />
        </>
      ) : mood === 'surprised' ? (
        <>
          <circle cx="14" cy="17" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="26" cy="17" r="1.4" fill="currentColor" stroke="none" />
          <ellipse cx="20" cy="25" rx="2.5" ry="3.4" />
        </>
      ) : (
        <>
          <circle cx="14" cy="17" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="26" cy="17" r="1.2" fill="currentColor" stroke="none" />
          <path d="M15.5 23c1.7 3.3 7.3 3.3 9 0" />
        </>
      )}
    </svg>
  )
}

export default function StageControls({
  stageRef,
  capabilities,
}: {
  stageRef: RefObject<Live2DStageHandle | null>
  capabilities: Live2DCapabilities | null
}) {
  const s = useStudio()
  const [motion, setMotion] = useState('')
  const [expression, setExpression] = useState('')
  const nativeRequest = useRef(0)
  useEffect(() => {
    ++nativeRequest.current
    setMotion(
      capabilities?.motions.find((m) => !/^idle$/i.test(m.group))?.id ||
        capabilities?.motions[0]?.id ||
        '',
    )
    setExpression('')
  }, [capabilities])
  useEffect(() => {
    ++nativeRequest.current
    setExpression('')
  }, [s.expressionRevision])
  const ready = capabilities?.ready ?? false
  const mood = (value: string) => {
    ++nativeRequest.current
    setExpression('')
    s.setMood(value)
    stageRef.current?.setMood(value)
  }
  const reset = () => {
    ++nativeRequest.current
    setExpression('')
    s.patch({ zoom: 1 })
    s.setMood('neutral')
    stageRef.current?.reset()
  }
  return (
    <div className="character-controls">
      <div className="character-controls-section">
        <div className="character-controls-label">
          <span>情绪表情</span>
          <small>跟随心情，随时切换</small>
        </div>
        <div className="character-mood-grid">
          {moods.map((e) => (
            <button
              type="button"
              key={e.key}
              disabled={!ready || (e.key !== 'neutral' && !capabilities?.supportsMoods)}
              className={`character-mood-card ${!expression && s.expression === e.key ? 'active' : ''}`}
              aria-pressed={!expression && s.expression === e.key}
              onClick={() => mood(e.key)}
            >
              <MoodFace mood={e.key} />
              <span>{e.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="character-controls-section">
        <div className="character-controls-label">
          <span>角色动作</span>
          <small>{ready ? `${capabilities?.motions.length || 0} 个可用` : '正在读取…'}</small>
        </div>
        <div className="character-motion-row">
          <select
            aria-label="选择角色动作"
            value={motion}
            disabled={!ready || !motion}
            onChange={(e) => setMotion(e.target.value)}
            title="选择角色自带的动作"
          >
            {!capabilities?.motions.length && <option value="">暂无动作</option>}
            {capabilities?.motions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="character-play-button"
            disabled={!ready || !motion}
            onClick={() => void stageRef.current?.playMotion(motion)}
            title="播放选中动作"
          >
            <Play size={14} />
            播放
          </button>
        </div>
        <button
          type="button"
          className="character-random-button"
          disabled={!ready || !motion}
          onClick={() => void stageRef.current?.playMotion()}
          title="随机播放角色动作"
        >
          <Shuffle size={14} />
          来一个随机小动作
        </button>
      </div>
      <div className="character-controls-section">
        <div className="character-controls-label">
          <span>模型原生表情</span>
          <small>{ready ? `${capabilities?.expressions.length || 0} 个可用` : '正在读取…'}</small>
        </div>
        {!!capabilities?.expressions.length ? (
          <select
            aria-label="选择模型原生表情"
            disabled={!ready}
            value={expression}
            onChange={async (e) => {
              const value = e.target.value
              const previous = expression
              const request = ++nativeRequest.current
              setExpression(value)
              if (!value) mood('neutral')
              else {
                const applied = await stageRef.current?.setExpression(value)
                if (!applied && nativeRequest.current === request) setExpression(previous)
              }
            }}
          >
            <option value="">自然 / 情绪表情</option>
            {capabilities.expressions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        ) : (
          <p className="character-controls-empty">
            {ready ? '当前模型没有自带表情，可以使用上方情绪卡片。' : '正在读取模型的表情资源…'}
          </p>
        )}
      </div>
      <button
        type="button"
        className="character-reset-button"
        disabled={!ready}
        onClick={reset}
        title="还原角色表情、动作和缩放"
      >
        <RotateCcw size={14} />
        恢复自然视图
      </button>
    </div>
  )
}
