/**
 * 文件职责：舞台自定义叠加层渲染（位于角色前方）。
 * 支持图片、视频、HTML 预设与混合模式，加载失败时给出可恢复的提示。
 */
import { useEffect, useState } from 'react'
import { mediaURL } from '../../api/client'
import { useStudio } from '../../store/studio'
import StageHTMLFrame from './StageHTMLFrame'
import { overlayHTMLPresets } from './stageHTMLPresets'

export default function StageOverlay() {
  const { sceneAssets, overlayAssetID, overlayOpacity, overlayBlendMode } = useStudio()
  const asset = sceneAssets.find((item) => item.id === overlayAssetID && item.kind !== 'html')
  const preset = overlayHTMLPresets.find((item) => item.id === overlayAssetID)
  const [failedID, setFailedID] = useState('')
  // 切换素材时清除上一次的加载失败记录。
  useEffect(() => setFailedID(''), [overlayAssetID])
  if (!asset && !preset) return null
  if (failedID === asset?.id) {
    return (
      <span className="stage-overlay-error" role="alert">
        叠加素材加载失败，请在特效面板清除后重新选择。
      </span>
    )
  }
  return (
    <div
      className="stage-custom-overlay"
      aria-label={`叠加特效：${preset?.name ?? asset?.name}`}
      style={{ opacity: overlayOpacity, mixBlendMode: overlayBlendMode }}
    >
      {preset ? (
        <StageHTMLFrame key={preset.id} title={`HTML 特效：${preset.name}`} source={preset.source} />
      ) : asset?.kind === 'video' ? (
        <video
          key={asset.id}
          src={mediaURL(asset.url)}
          muted
          autoPlay
          playsInline
          loop
          onError={() => setFailedID(asset.id)}
        />
      ) : asset ? (
        <img src={mediaURL(asset.url)} alt="" onError={() => setFailedID(asset.id)} />
      ) : null}
    </div>
  )
}
