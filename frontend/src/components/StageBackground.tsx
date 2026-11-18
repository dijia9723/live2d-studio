/**
 * 文件职责：舞台背景渲染层。
 * 渲染图片、静音循环视频或隔离的 HTML 背景，并应用压暗遮罩。
 */
import { useEffect, useRef, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { api, mediaURL } from '../api/client'
import { useStudio } from '../store/studio'

const htmlPolicy =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"
const htmlPrelude = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${htmlPolicy}"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style>`

export default function StageBackground() {
  const { sceneAssets, backgroundAssetID, backgroundFit, backgroundDim, videoPlaying } = useStudio()
  const asset = sceneAssets.find((item) => item.id === backgroundAssetID)
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState(false)
  const [html, setHTML] = useState<{ id: string; document: string }>()
  useEffect(() => {
    setError(false)
    setHTML(undefined)
    if (asset?.kind !== 'html') return
    const controller = new AbortController()
    void api.sceneAssetHTML(asset.url, controller.signal).then(
      (source) => {
        if (!controller.signal.aborted) setHTML({ id: asset.id, document: htmlPrelude + source })
      },
      () => {
        if (!controller.signal.aborted) setError(true)
      },
    )
    return () => controller.abort()
  }, [asset?.id, asset?.kind, asset?.url])
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
      ) : asset.kind === 'image' ? (
        <img
          src={mediaURL(asset.url)}
          alt=""
          style={{ objectFit: backgroundFit }}
          onError={() => setError(true)}
        />
      ) : html?.id === asset.id ? (
        <iframe
          key={asset.id}
          title={`HTML 背景：${asset.name}`}
          srcDoc={html.document}
          sandbox=""
          referrerPolicy="no-referrer"
          inert
          tabIndex={-1}
        />
      ) : null}
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
