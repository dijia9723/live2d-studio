import { useEffect, useRef } from 'react'
import { Video, VideoOff } from 'lucide-react'

interface Props {
  stream: MediaStream | null
  enabled: boolean
  message: string
  error: string
  onToggle: () => void
}

export default function CameraPanel({ stream, enabled, message, error, onToggle }: Props) {
  const video = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const preview = video.current
    if (!preview || !stream) return
    preview.srcObject = stream
    return () => {
      preview.srcObject = null
    }
  }, [stream])

  return (
    <div className="camera-panel-content">
      <header className="camera-panel-heading">
        <div>
          <h3>实时画面</h3>
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
      <div className="camera-preview">
        {stream ? (
          <>
            <video ref={video} autoPlay muted playsInline aria-label="摄像头实时镜像预览" />
            <span className="camera-preview-label">镜像预览</span>
          </>
        ) : (
          <div className="camera-preview-empty" aria-hidden="true">
            <VideoOff size={28} />
            <span>{enabled ? '正在连接摄像头…' : '摄像头未开启'}</span>
          </div>
        )}
      </div>
      <p className={error ? 'camera-panel-status error' : 'camera-panel-status'} role="status">
        {message || '开启后可在这里预览画面并驱动角色。'}
      </p>
      <p className="camera-panel-privacy">
        画面仅在本机处理，不录制、不上传。切换标签不会关闭摄像头。
      </p>
    </div>
  )
}
