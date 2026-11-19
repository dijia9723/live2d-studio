import { useEffect, useRef, type RefObject } from 'react'
import { Video, VideoOff } from 'lucide-react'
import CameraSkeleton from './CameraSkeleton'
import type { CameraLandmarks } from '../utils/cameraTracking'

export type CameraPreviewMode = 'skeleton' | 'video'

const previewModes = [
  { id: 'skeleton', label: '骨骼' },
  { id: 'video', label: '实时视频' },
] as const

interface Props {
  stream: MediaStream | null
  landmarks: RefObject<CameraLandmarks | null>
  mode: CameraPreviewMode
  onModeChange: (mode: CameraPreviewMode) => void
  enabled: boolean
  message: string
  error: string
  onToggle: () => void
}

export default function CameraPanel({
  stream,
  landmarks,
  mode,
  onModeChange,
  enabled,
  message,
  error,
  onToggle,
}: Props) {
  const video = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const preview = video.current
    if (!preview || !stream) return
    preview.srcObject = stream
    return () => {
      preview.srcObject = null
    }
  }, [stream, mode])

  return (
    <div className="camera-panel-content">
      <header className="camera-panel-heading">
        <div>
          <h3>摄像头预览</h3>
          <p>让脸和双肩进入镜头，角色会镜像跟随。</p>
        </div>
        <button
          type="button"
          className={`button ${enabled ? 'ghost' : 'primary'}`}
          onClick={onToggle}
        >
          {enabled ? <VideoOff size={16} /> : <Video size={16} />}
          {enabled ? '关闭摄像头' : '开启摄像头'}
        </button>
      </header>
      <div className="camera-preview-modes" role="group" aria-label="摄像头预览模式">
        {previewModes.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={mode === id}
            onClick={() => onModeChange(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="camera-preview">
        {stream ? (
          mode === 'video' ? (
            <video ref={video} autoPlay muted playsInline aria-label="摄像头实时镜像预览" />
          ) : (
            <CameraSkeleton landmarks={landmarks} />
          )
        ) : (
          <div className="camera-preview-empty" aria-hidden="true">
            <VideoOff size={28} />
            <span>{enabled ? '正在连接摄像头…' : '摄像头未开启'}</span>
          </div>
        )}
      </div>
      <p className={error ? 'camera-panel-status error' : 'camera-panel-status'} role="status">
        {message || '开启摄像头以预览追踪并驱动角色。'}
      </p>
      <p className="camera-panel-privacy">
        画面仅在本机处理，不录制、不上传。切换标签不会关闭摄像头。
      </p>
    </div>
  )
}
