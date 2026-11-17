import { useEffect, useRef, useState } from 'react'
import { Check, Film, ImagePlus, LoaderCircle, Pause, Play, Trash2, Upload, X } from 'lucide-react'
import { api, mediaURL } from '../api/client'
import { notify, useStudio } from '../store/studio'
import type { SceneAsset } from '../types/api'

const backgrounds = [
  { id: 'lavender', name: '暮紫花园' },
  { id: 'peach', name: '蜜桃暖阳' },
  { id: 'mint', name: '薄荷清晨' },
  { id: 'night', name: '静谧夜色' },
]
export default function BackgroundManager() {
  const s = useStudio()
  const input = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')
  const [removing, setRemoving] = useState<SceneAsset | null>(null)
  const [deleting, setDeleting] = useState(false)
  const selected = s.sceneAssets.find((asset) => asset.id === s.backgroundAssetID)
  useEffect(() => {
    void s
      .refreshSceneAssets()
      .catch(() => setError('背景库读取失败，请检查本地服务是否已更新并重启。'))
  }, [])
  const upload = async (file?: File) => {
    if (!file || uploading) return
    const video = /\.(mp4|webm)$/i.test(file.name)
    if (!/\.(png|jpe?g|webp|gif|mp4|webm)$/i.test(file.name)) {
      setError('支持 PNG、JPEG、WebP、GIF 图片和 MP4、WebM 视频')
      return
    }
    if (file.size > (video ? 150 : 15) * 1024 * 1024) {
      setError(video ? '视频最大支持 150MB' : '图片最大支持 15MB')
      return
    }
    setUploading(true)
    setProgress(0)
    setError('')
    try {
      const asset = await api.uploadSceneAsset(file, setProgress)
      useStudio.setState((state) => ({
        sceneAssets: [asset, ...state.sceneAssets],
        backgroundAssetID: asset.id,
        videoPlaying: true,
      }))
      notify(`已添加并应用背景：${asset.name}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '背景上传失败')
    } finally {
      setUploading(false)
    }
  }
  const remove = async () => {
    if (!removing || deleting) return
    setDeleting(true)
    try {
      await api.deleteSceneAsset(removing.id)
      useStudio.setState((state) => ({
        sceneAssets: state.sceneAssets.filter((asset) => asset.id !== removing.id),
        backgroundAssetID: state.backgroundAssetID === removing.id ? null : state.backgroundAssetID,
        overlayAssetID: state.overlayAssetID === removing.id ? null : state.overlayAssetID,
      }))
      setRemoving(null)
      notify('背景已删除')
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败')
    } finally {
      setDeleting(false)
    }
  }
  return (
    <div className="background-manager">
      <div className="panel-section-heading">
        <div>
          <h3>你的舞台，你的风景</h3>
          <p>导入喜欢的图片，或让视频在背景中循环。</p>
        </div>
        <span className="subtle-count">{s.sceneAssets.length} 个素材</span>
      </div>
      <button
        className={`background-upload ${dragging ? 'dragging' : ''}`}
        disabled={uploading}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void upload(e.dataTransfer.files[0])
        }}
      >
        <span className="upload-glyph">
          {uploading ? <LoaderCircle className="spin" size={23} /> : <Upload size={23} />}
        </span>
        <strong>{uploading ? `正在导入 ${Math.min(progress, 100)}%` : '点击或拖入背景素材'}</strong>
        <small>图片 ≤ 15MB · 视频 ≤ 150MB</small>
        {uploading && (
          <span className="upload-progress" style={{ width: `${Math.min(progress, 100)}%` }} />
        )}
      </button>
      <input
        ref={input}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"
        onChange={(e) => {
          void upload(e.target.files?.[0])
          e.target.value = ''
        }}
      />
      {error && (
        <p className="panel-error" role="alert">
          {error}
          <button aria-label="关闭背景错误" onClick={() => setError('')}>
            <X size={13} />
          </button>
        </p>
      )}
      <div className="panel-label">内置背景</div>
      <div className="builtin-background-grid">
        {backgrounds.map((item) => (
          <button
            key={item.id}
            className={`builtin-background stage-${item.id} ${!s.backgroundAssetID && s.stage === item.id ? 'selected' : ''}`}
            onClick={() => s.patch({ stage: item.id, backgroundAssetID: null })}
          >
            <span>{item.name}</span>
            {!s.backgroundAssetID && s.stage === item.id && <Check size={13} />}
          </button>
        ))}
      </div>
      <div className="media-library-heading">
        <span className="panel-label">我的素材</span>
        <div className="media-filter">
          {[
            { id: 'all', name: '全部' },
            { id: 'image', name: '图片' },
            { id: 'video', name: '视频' },
          ].map((item) => (
            <button
              key={item.id}
              className={filter === item.id ? 'active' : ''}
              onClick={() => setFilter(item.id)}
            >
              {item.name}
            </button>
          ))}
        </div>
      </div>
      <div className="background-library">
        {s.sceneAssets
          .filter((asset) => filter === 'all' || filter === asset.kind)
          .map((asset) => (
            <div
              key={asset.id}
              className={`media-card ${s.backgroundAssetID === asset.id ? 'selected' : ''}`}
            >
              <button
                className="media-select"
                aria-label={`应用背景 ${asset.name}`}
                aria-pressed={s.backgroundAssetID === asset.id}
                onClick={() => s.patch({ backgroundAssetID: asset.id, videoPlaying: true })}
              >
                <div className="media-thumbnail">
                  {asset.kind === 'image' ? (
                    <img loading="lazy" src={mediaURL(asset.url)} alt="" />
                  ) : (
                    <video src={mediaURL(asset.url)} muted playsInline preload="metadata" />
                  )}
                  <span className="media-kind">
                    {asset.kind === 'video' ? <Film size={11} /> : <ImagePlus size={11} />}
                    {asset.kind === 'video' ? '视频' : '图片'}
                  </span>
                  {s.backgroundAssetID === asset.id && (
                    <span className="media-check">
                      <Check size={12} />
                    </span>
                  )}
                </div>
                <span className="media-name" title={asset.name}>
                  {asset.name}
                </span>
                <small>{(asset.size / 1024 / 1024).toFixed(1)} MB</small>
              </button>
              <button
                className="media-delete"
                aria-label={`删除背景 ${asset.name}`}
                onClick={() => setRemoving(asset)}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
      </div>
      {!s.sceneAssets.some((asset) => filter === 'all' || filter === asset.kind) && (
        <div className="media-empty">
          <ImagePlus size={23} />
          <p>把喜欢的风景收藏在这里</p>
          <small>导入后即可应用，素材保存在本机。</small>
        </div>
      )}
      {selected && (
        <div className="background-adjustments">
          <div className="panel-label">背景显示</div>
          <label>
            画面适配
            <select
              aria-label="背景画面适配"
              value={s.backgroundFit}
              onChange={(e) => s.patch({ backgroundFit: e.target.value as 'cover' | 'contain' })}
            >
              <option value="cover">铺满画布</option>
              <option value="contain">完整显示</option>
            </select>
          </label>
          <label>
            背景压暗<span>{Math.round(s.backgroundDim * 100)}%</span>
            <input
              aria-label="背景压暗"
              type="range"
              min={0}
              max={0.8}
              step={0.01}
              value={s.backgroundDim}
              onChange={(e) => s.patch({ backgroundDim: Number(e.target.value) })}
            />
          </label>
          {selected.kind === 'video' && (
            <button
              className="button ghost video-playback"
              onClick={() => s.patch({ videoPlaying: !s.videoPlaying })}
            >
              {s.videoPlaying ? <Pause size={14} /> : <Play size={14} />}
              {s.videoPlaying ? '暂停视频背景' : '播放视频背景'}
              <small>静音循环播放</small>
            </button>
          )}
        </div>
      )}
      {removing && (
        <div className="panel-confirm" role="alertdialog" aria-label="删除背景确认">
          <strong>删除“{removing.name}”？</strong>
          <p>将从本地素材库移除，正在使用的背景会恢复为内置背景。</p>
          <div>
            <button disabled={deleting} className="button ghost" onClick={() => setRemoving(null)}>
              取消
            </button>
            <button disabled={deleting} className="button danger" onClick={() => void remove()}>
              {deleting ? '正在删除…' : '删除背景'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
