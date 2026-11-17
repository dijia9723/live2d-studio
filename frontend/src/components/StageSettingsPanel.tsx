import { useState } from 'react'
import type { RefObject } from 'react'
import { Image, Layers, Smile, Sparkles } from 'lucide-react'
import StageControls from './StageControls'
import BackgroundManager from './BackgroundManager'
import OverlayManager from './OverlayManager'
import { effectPresets } from './StageEffects'
import { useStudio } from '../store/studio'
import type { Live2DCapabilities, Live2DStageHandle } from './Live2DStage'

export default function StageSettingsPanel({
  stageRef,
  capabilities,
  interaction,
}: {
  stageRef: RefObject<Live2DStageHandle | null>
  capabilities: Live2DCapabilities | null
  interaction: string
}) {
  const [tab, setTab] = useState('character')
  const s = useStudio()
  const setEffect = (id: string, patch: { enabled?: boolean; intensity?: number }) => {
    const current = s.effects.find((effect) => effect.id === id)
    s.patch({
      effects: [
        ...s.effects.filter((effect) => effect.id !== id),
        { id, enabled: false, intensity: 0.5, ...current, ...patch },
      ],
    })
  }
  const activeEffects = s.effects.filter((effect) => effect.enabled).length
  const totalEffects = activeEffects + (s.overlayAssetID ? 1 : 0)
  return (
    <section className="stage-settings-panel" aria-label="舞台设置面板">
      <div className="stage-settings-header">
        <span className="stage-settings-icon">
          <Layers size={19} />
        </span>
        <div>
          <h2>布置你的小小世界</h2>
          <p>每一个细节，都按你的心意。</p>
        </div>
        <span className="settings-live-dot" title="修改实时生效" />
      </div>
      <div className="stage-category-tabs" role="tablist" aria-label="舞台设置分类">
        {[
          { id: 'character', name: '角色', Icon: Smile },
          { id: 'background', name: '背景', Icon: Image },
          { id: 'effects', name: '特效', Icon: Sparkles },
        ].map(({ id, name, Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            aria-controls={`stage-category-${id}`}
            onClick={() => setTab(id)}
          >
            <Icon size={15} />
            {name}
            {id === 'effects' && totalEffects > 0 && <span>{totalEffects}</span>}
          </button>
        ))}
      </div>
      <div className="stage-settings-scroll">
        <div role="tabpanel" id="stage-category-character" hidden={tab !== 'character'}>
          <div className="panel-section-heading">
            <div>
              <h3>让情绪，变得生动</h3>
              <p>选择表情，或播放角色自带的动作。</p>
            </div>
          </div>
          <StageControls stageRef={stageRef} capabilities={capabilities} />
          {interaction && (
            <div className="character-interaction" role="status" aria-live="polite">
              <span />
              {interaction}
            </div>
          )}
          <div className="character-tip">
            <Sparkles size={16} />
            <p>试着在画布上移动鼠标，伙伴会看向你；轻点角色，还能收到一个小动作。</p>
          </div>
        </div>
        <div role="tabpanel" id="stage-category-background" hidden={tab !== 'background'}>
          <BackgroundManager />
        </div>
        <div role="tabpanel" id="stage-category-effects" hidden={tab !== 'effects'}>
          <div className="panel-section-heading">
            <div>
              <h3>给画面加一点魔法</h3>
              <p>特效在角色上方叠加，可以自由组合。</p>
            </div>
          </div>
          <div className="effects-heading">
            <span className="panel-label">氛围特效 · {activeEffects} 个已开启</span>
            <button
              disabled={!activeEffects}
              onClick={() =>
                s.patch({ effects: s.effects.map((effect) => ({ ...effect, enabled: false })) })
              }
            >
              全部关闭
            </button>
          </div>
          <div className="effect-library">
            {effectPresets.map((preset) => {
              const effect = s.effects.find((item) => item.id === preset.id)
              const enabled = effect?.enabled ?? false
              return (
                <div
                  className={`effect-card effect-card-${preset.id} ${enabled ? 'enabled' : ''}`}
                  key={preset.id}
                >
                  <div className="effect-card-top">
                    <span className={`effect-preview effect-preview-${preset.id}`}>
                      {preset.icon}
                    </span>
                    <div>
                      <h4>{preset.name}</h4>
                      <p>{preset.description}</p>
                    </div>
                    <button
                      className={`switch ${enabled ? 'on' : ''}`}
                      role="switch"
                      aria-label={`启用${preset.name}`}
                      aria-checked={enabled}
                      onClick={() => setEffect(preset.id, { enabled: !enabled })}
                    >
                      <span />
                    </button>
                  </div>
                  {enabled && (
                    <label className="effect-intensity">
                      效果强度
                      <input
                        type="range"
                        min={0.1}
                        max={1}
                        step={0.1}
                        value={effect?.intensity ?? 0.5}
                        aria-label={`${preset.name}强度`}
                        onChange={(e) =>
                          setEffect(preset.id, { intensity: Number(e.target.value) })
                        }
                      />
                      <span>{Math.round((effect?.intensity ?? 0.5) * 100)}%</span>
                    </label>
                  )}
                </div>
              )
            })}
          </div>
          <OverlayManager />
          <div className="character-tip">
            <Layers size={16} />
            <p>
              背景在最底层，Live2D 角色居中，特效覆盖在最上层。切回 AI 对话，舞台效果会继续保留。
            </p>
          </div>
        </div>
      </div>
      <div className="stage-settings-footer">
        <span className="status-dot" />
        即时预览 · 自动保存在本机
      </div>
    </section>
  )
}
