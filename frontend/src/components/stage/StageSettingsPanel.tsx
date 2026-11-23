/**
 * 文件职责：舞台设置面板，组合角色控制、背景、特效与自由画布组件。
 * 包含完整的方向键/Home/End 键盘导航与 ARIA tab 语义。
 */
import type { RefObject } from 'react'
import { Link } from 'react-router-dom'
import { Image, LayoutTemplate, PanelsTopLeft, Smile, Sparkles } from 'lucide-react'
import StageControls from './StageControls'
import BackgroundManager from './BackgroundManager'
import OverlayManager from './OverlayManager'
import CanvasWidgetManager from '../canvas/CanvasWidgetManager'
import StageTemplateManager from './StageTemplateManager'
import { effectPresets } from './StageEffects'
import { Switch } from '../ui/switch'
import { useStudio } from '../../store/studio'
import type { Live2DCapabilities, Live2DStageHandle } from './Live2DStage'

const categories = [
  { id: 'character', name: '表情与动作', Icon: Smile },
  { id: 'background', name: '背景', Icon: Image },
  { id: 'effects', name: '特效', Icon: Sparkles },
  { id: 'widgets', name: '组件', Icon: LayoutTemplate },
  { id: 'templates', name: '模板', Icon: PanelsTopLeft },
]

/**
 * @param stageRef 舞台控制句柄，透传给角色控制子面板
 * @param capabilities 当前模型能力
 * @param interaction 舞台反馈文案（来自 Live2DStage）
 * @param category 当前分类，由工作台控制以支持从画布打开组件编辑器
 * @param onCategoryChange 分类切换回调
 */
export default function StageSettingsPanel({
  stageRef,
  capabilities,
  interaction,
  category: tab,
  onCategoryChange: setTab,
}: {
  stageRef: RefObject<Live2DStageHandle | null>
  capabilities: Live2DCapabilities | null
  interaction: string
  category: string
  onCategoryChange: (category: string) => void
}) {
  const s = useStudio()
  // 合并写入单个特效设置：不存在时创建，已存在时覆盖指定字段。
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
      <div
        className="stage-category-tabs"
        role="tablist"
        aria-label="舞台设置分类"
        onKeyDown={(event) => {
          const current = categories.findIndex((category) => category.id === tab)
          const last = categories.length - 1
          let next: number
          switch (event.key) {
            case 'ArrowLeft':
              next = current === 0 ? last : current - 1
              break
            case 'ArrowRight':
              next = current === last ? 0 : current + 1
              break
            case 'Home':
              next = 0
              break
            case 'End':
              next = last
              break
            default:
              return
          }
          event.preventDefault()
          setTab(categories[next].id)
          event.currentTarget.querySelectorAll('button')[next]?.focus()
        }}
      >
        {categories.map(({ id, name, Icon }) => (
          <button
            key={id}
            id={`stage-tab-${id}`}
            role="tab"
            tabIndex={tab === id ? 0 : -1}
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
        <div
          role="tabpanel"
          id="stage-category-character"
          aria-labelledby="stage-tab-character"
          hidden={tab !== 'character'}
        >
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
        <div
          role="tabpanel"
          id="stage-category-background"
          aria-labelledby="stage-tab-background"
          hidden={tab !== 'background'}
        >
          <BackgroundManager />
        </div>
        <div
          role="tabpanel"
          id="stage-category-effects"
          aria-labelledby="stage-tab-effects"
          hidden={tab !== 'effects'}
        >
          <OverlayManager />
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
                    <Switch
                      aria-label={`启用${preset.name}`}
                      className="ml-auto"
                      checked={enabled}
                      onCheckedChange={(checked) => setEffect(preset.id, { enabled: checked })}
                    />
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
        </div>
        <div
          role="tabpanel"
          id="stage-category-widgets"
          aria-labelledby="stage-tab-widgets"
          hidden={tab !== 'widgets'}
        >
          <CanvasWidgetManager />
        </div>
        <div
          role="tabpanel"
          id="stage-category-templates"
          aria-labelledby="stage-tab-templates"
          hidden={tab !== 'templates'}
        >
          <StageTemplateManager />
        </div>
      </div>
      <div className="stage-settings-footer">
        <span className="status-dot" />
        更改即时预览并自动保存
        <Link to="/settings?section=stage">设置模型操作范围</Link>
      </div>
    </section>
  )
}
