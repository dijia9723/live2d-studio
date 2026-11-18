/** 文件职责：画布外的比例与预览入口，隐藏画布按钮后仍能恢复操作。 */
import { Eye, EyeOff, PanelsTopLeft, Ratio } from 'lucide-react'
import { useStudio } from '../store/studio'
import { stageAspectPresets, type StageAspect } from '../types/stage'

export default function StageViewToolbar({ onTemplates }: { onTemplates: () => void }) {
  const { aspect, controlsVisible, patch } = useStudio()
  return (
    <div className="stage-view-toolbar" role="group" aria-label="画布显示设置">
      <label className="stage-aspect-select">
        <Ratio size={15} aria-hidden="true" />
        <select
          aria-label="画布比例"
          value={aspect}
          onChange={(event) => patch({ aspect: event.target.value as StageAspect })}
        >
          {stageAspectPresets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
      <div className="stage-view-actions">
        <button title="保存或应用舞台模板" onClick={onTemplates}>
          <PanelsTopLeft size={15} />
          模板
        </button>
        <button
          aria-label={controlsVisible ? '隐藏画布按钮' : '显示画布按钮'}
          aria-pressed={!controlsVisible}
          aria-keyshortcuts="H"
          title={`${controlsVisible ? '隐藏' : '显示'}角色、编辑与缩放按钮（H）`}
          onClick={() => patch({ controlsVisible: !controlsVisible })}
        >
          {controlsVisible ? <Eye size={15} /> : <EyeOff size={15} />}
          {controlsVisible ? '隐藏按钮' : '显示按钮'}
        </button>
      </div>
    </div>
  )
}
