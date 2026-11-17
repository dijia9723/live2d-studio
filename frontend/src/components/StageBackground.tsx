/**
 * 文件职责：舞台背景渲染层。
 * 根据当前选中的场景素材渲染图片或静音循环视频，并应用适配方式与压暗遮罩。
 */
import { useEffect, useRef, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { mediaURL } from '../api/client'
import { useStudio } from '../store/studio'

export default function StageBackground() {
  const { sceneAssets, backgroundAssetID, backgroundFit, backgroundDim, videoPlaying } = useStudio()
  const asset = sceneAssets.find((item) => item.id === backgroundAssetID)
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState(false)
  // 切换素材时重置错误状态。
  useEffect(() => setError(false), [asset?.id])
  // 与全局播放状态同步视频；浏览器可能因自动播放策略拒绝 play，忽略即可。
  useEffect(() => {
    const element = video.current
    if (!element) return
    if (videoPlaying) void element.play().catch(() => {})
    else element.pause()
  }, [videoPlaying, asset?.id])
  if (!asset) return null
  return (
    <div className="stage-media" aria-label={`当前背景：${asset.name}`}>
      {asset.kind === 'video' ? (
        <video
          key={asset.id}
          ref={video}
          src={mediaURL(asset.url)}
          muted
          loop
          playsInline
          autoPlay={videoPlaying}
          preload="auto"
          style={{ objectFit: backgroundFit }}
          onError={() => setError(true)}
        />
      ) : (
        <img
          src={mediaURL(asset.url)}
          alt=""
          style={{ objectFit: backgroundFit }}
          onError={() => setError(true)}
        />
      )}
      <div className="stage-media-shade" style={{ opacity: backgroundDim }} />
      {error && (
        <span className="stage-media-error" role="alert">
          <ImageOff size={14} />
          背景加载失败，请重新选择或导入
        </span>
      )}
    </div>
  )
}
