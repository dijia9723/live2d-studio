/** 文件职责：画布外的比例与预览入口，隐藏画布按钮后仍能恢复操作。 */
import { Eye, EyeOff, PanelsTopLeft, Ratio, Video, VideoOff } from 'lucide-react'
import { useStudio } from '../store/studio'
import { stageAspectPresets, type StageAspect } from '../types/stage'

interface Props {
  onTemplates: () => void
  cameraAvailable: boolean
  cameraEnabled: boolean
  onToggleCamera: () => void
}

export default function StageViewToolbar({
  onTemplates,
  cameraAvailable,
  cameraEnabled,
  onToggleCamera,
}: Props) {
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
        <button
          type="button"
          aria-pressed={cameraEnabled}
          title={cameraEnabled ? '关闭摄像头并恢复鼠标跟随' : '用摄像头实时跟随头脸和上半身动作'}
          disabled={!cameraAvailable}
          onClick={onToggleCamera}
        >
          {cameraEnabled ? <Video size={15} /> : <VideoOff size={15} />}
          摄像头跟随
        </button>
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
