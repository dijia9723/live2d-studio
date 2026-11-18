/**
 * 文件职责：舞台背景设置面板。
 * 负责内置背景选择、素材上传（校验类型/大小、拖拽）、素材筛选与删除、
 * 以及背景适配/压暗/视频播放等显示参数。
 */
import { useEffect, useRef, useState } from 'react'
import {
  Check,
  FileCode,
  Film,
  ImagePlus,
  LoaderCircle,
  Pause,
  Play,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { api, mediaURL } from '../api/client'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { notify, useStudio } from '../store/studio'
import type { SceneAsset } from '../types/api'

const backgrounds = [
  { id: 'lavender', name: '暮紫花园' },
  { id: 'peach', name: '蜜桃暖阳' },
  { id: 'mint', name: '薄荷清晨' },
  { id: 'night', name: '静谧夜色' },
]
const assetKinds = {
  image: { name: '图片', Icon: ImagePlus },
  video: { name: '视频', Icon: Film },
  html: { name: 'HTML', Icon: FileCode },
}

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
  // 进入面板时刷新素材库，兼容其他窗口新增的素材。
  useEffect(() => {
    void s
      .refreshSceneAssets()
      .catch(() => setError('背景库读取失败，请检查本地服务是否已更新并重启。'))
  }, [])
  // 上传前按扩展名与大小做前置校验，避免把明显不合法的文件传到后端。
  const upload = async (file?: File) => {
    if (!file || uploading) return
    const video = /\.(mp4|webm)$/i.test(file.name)
    const html = /\.html?$/i.test(file.name)
    if (!video && !html && !/\.(png|jpe?g|webp|gif)$/i.test(file.name)) {
      setError('支持 PNG、JPEG、WebP、GIF 图片，MP4、WebM 视频和 HTML 文件')
      return
    }
    const limit = video ? 150 : html ? 5 : 15
    if (file.size > limit * 1024 * 1024) {
      setError(`${video ? '视频' : html ? 'HTML' : '图片'}最大支持 ${limit}MB`)
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
      if (filter !== 'all' && filter !== asset.kind) setFilter(asset.kind)
      notify(`已添加并应用背景：${asset.name}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '背景上传失败')
    } finally {
      setUploading(false)
    }
  }
  // 删除素材后同步清理引用，避免背景/叠加层指向已删除的资源。
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
          <h3>背景素材</h3>
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
        <small>图片 ≤ 15MB · 视频 ≤ 150MB · HTML ≤ 5MB</small>
        {uploading && (
          <span className="upload-progress" style={{ width: `${Math.min(progress, 100)}%` }} />
        )}
      </button>
      <input
        ref={input}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,.html,.htm"
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
            aria-pressed={!s.backgroundAssetID && s.stage === item.id}
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
            ...Object.entries(assetKinds).map(([id, { name }]) => ({ id, name })),
          ].map((item) => (
            <button
              key={item.id}
              className={filter === item.id ? 'active' : ''}
              aria-pressed={filter === item.id}
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
          .map((asset) => {
            const { name, Icon } = assetKinds[asset.kind]
            return (
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
                    ) : asset.kind === 'video' ? (
                      <video src={mediaURL(asset.url)} muted playsInline preload="metadata" />
                    ) : (
                      <FileCode className="media-html-icon" size={28} aria-hidden="true" />
                    )}
                    <span className="media-kind">
                      <Icon size={11} />
                      {name}
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
            )
          })}
      </div>
      {!s.sceneAssets.some((asset) => filter === 'all' || filter === asset.kind) && (
        <div className="media-empty">
          <ImagePlus size={23} />
          <p>{filter === 'all' ? '还没有导入素材' : '没有符合筛选的素材'}</p>
        </div>
      )}
      {selected && (
        <div className="background-adjustments">
          <div className="panel-label">背景显示</div>
          {selected.kind === 'html' ? (
            <p className="media-html-hint">
              HTML 随画布大小调整，支持内联 CSS 动画和嵌入图片，不加载外部资源或运行脚本。
            </p>
          ) : (
            <label>
              画面适配
              <Select
                value={s.backgroundFit}
                onValueChange={(value) => s.patch({ backgroundFit: value as 'cover' | 'contain' })}
              >
                <SelectTrigger size="sm" aria-label="背景画面适配" className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cover">铺满画布</SelectItem>
                  <SelectItem value="contain">完整显示</SelectItem>
                </SelectContent>
              </Select>
            </label>
          )}
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
