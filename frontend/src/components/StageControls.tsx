/**
 * 文件职责：角色表情与动作控制面板。
 * 提供情绪卡片、模型原生表情、动作选择/随机播放与重置视图。
 */
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Play, RotateCcw, Shuffle } from 'lucide-react'
import { actionDisplayName } from '../utils/actionNames'
import type { Live2DCapabilities, Live2DStageHandle } from './Live2DStage'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { useStudio } from '../store/studio'

const moods = [
  { key: 'neutral', label: '自然' },
  { key: 'happy', label: '开心' },
  { key: 'sad', label: '难过' },
  { key: 'surprised', label: '惊讶' },
]

/** 纯 SVG 绘制的情绪图标，避免依赖图片资源。 */
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

/**
 * @param stageRef 舞台命令式控制句柄
 * @param capabilities 模型能力描述（动作/表情/是否支持情绪参数）
 */
export default function StageControls({
  stageRef,
  capabilities,
}: {
  stageRef: RefObject<Live2DStageHandle | null>
  capabilities: Live2DCapabilities | null
}) {
  const s = useStudio()
  const character = s.characters.find((item) => item.id === s.characterID) ?? s.characters[0]
  const [motion, setMotion] = useState('')
  const [expression, setExpression] = useState('')
  // nativeRequest 用于丢弃已失效的原生表情切换结果。
  const nativeRequest = useRef(0)
  // 能力更新时重置默认动作，并清空原生表情选择。
  useEffect(() => {
    ++nativeRequest.current
    setMotion(
      capabilities?.motions.find((m) => !/^idle$/i.test(m.group))?.id ||
        capabilities?.motions[0]?.id ||
        '',
    )
    setExpression('')
  }, [capabilities])
  // 全局表情变更（如 AI 切换情绪）时退出原生表情模式。
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
    stageRef.current?.resetModelView()
    s.setMood('neutral')
    stageRef.current?.reset()
  }
  return (
    <div className="character-controls">
      <div className="character-controls-section">
        <div className="character-controls-label">
          <span>情绪表情</span>
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
              <span title={e.label}>
                {actionDisplayName(character?.action_names, 'moods', e.key, e.label)}
              </span>
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
          <Select
            value={motion || 'none'}
            disabled={!ready || !motion}
            onValueChange={(value) => setMotion(value === 'none' ? '' : value)}
          >
            <SelectTrigger
              aria-label="选择角色动作"
              title="选择角色自带的动作"
              className="h-[38px] flex-1"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {!capabilities?.motions.length && <SelectItem value="none">暂无动作</SelectItem>}
              {capabilities?.motions.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {actionDisplayName(character?.action_names, 'motions', item.id, item.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
          随机播放
        </button>
      </div>
      <div className="character-controls-section">
        <div className="character-controls-label">
          <span>模型原生表情</span>
          <small>{ready ? `${capabilities?.expressions.length || 0} 个可用` : '正在读取…'}</small>
        </div>
        {!!capabilities?.expressions.length ? (
          <Select
            disabled={!ready}
            value={expression || 'none'}
            onValueChange={async (value) => {
              const next = value === 'none' ? '' : value
              const previous = expression
              const request = ++nativeRequest.current
              setExpression(next)
              if (!next) mood('neutral')
              else {
                const applied = await stageRef.current?.setExpression(next)
                if (!applied && nativeRequest.current === request) setExpression(previous)
              }
            }}
          >
            <SelectTrigger aria-label="选择模型原生表情" className="h-[38px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">自然 / 情绪表情</SelectItem>
              {capabilities.expressions.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {actionDisplayName(character?.action_names, 'expressions', item.id, item.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
        title="还原模型位置、缩放、表情和动作"
      >
        <RotateCcw size={14} />
        重置角色视图
      </button>
    </div>
  )
}
