import { useEffect, useRef, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { mediaURL } from '../api/client'
import { useStudio } from '../store/studio'

export default function StageBackground() {
  const { sceneAssets, backgroundAssetID, backgroundFit, backgroundDim, videoPlaying } = useStudio()
  const asset = sceneAssets.find((item) => item.id === backgroundAssetID)
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState(false)
  useEffect(() => setError(false), [asset?.id])
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
