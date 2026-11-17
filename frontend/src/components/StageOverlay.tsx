/**
 * 文件职责：舞台自定义叠加层渲染（位于角色前方）。
 * 支持图片/视频与混合模式，加载失败时给出可恢复的提示。
 */
import { useEffect, useState } from 'react'
import { mediaURL } from '../api/client'
import { useStudio } from '../store/studio'

export default function StageOverlay() {
  const { sceneAssets, overlayAssetID, overlayOpacity, overlayBlendMode } = useStudio()
  const asset = sceneAssets.find((item) => item.id === overlayAssetID)
  const [failedID, setFailedID] = useState('')
  // 切换素材时清除上一次的加载失败记录。
  useEffect(() => setFailedID(''), [overlayAssetID])
  if (!asset) return null
  if (failedID === asset.id) return <span className="stage-overlay-error" role="alert">叠加素材加载失败，请在特效面板清除后重新选择。</span>
  return (
    <div
      className="stage-custom-overlay"
      aria-label={`叠加特效：${asset.name}`}
      style={{ opacity: overlayOpacity, mixBlendMode: overlayBlendMode }}
    >
      {asset.kind === 'video' ? (
        <video
          key={asset.id}
          src={mediaURL(asset.url)}
          muted
          autoPlay
          playsInline
          loop
          onError={() => setFailedID(asset.id)}
        />
      ) : (
        <img src={mediaURL(asset.url)} alt="" onError={() => setFailedID(asset.id)} />
      )}
    </div>
  )
}
