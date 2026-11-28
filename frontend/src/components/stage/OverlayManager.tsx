/**
 * 文件职责：舞台自定义叠加层（图片/视频特效）设置面板。
 * 负责素材导入与校验、选择/清除叠加素材、强度与混合模式调节。
 */
import { useEffect, useRef, useState } from 'react'
import { Check, FileCode, Film, Image, Layers, LoaderCircle, Upload, X } from 'lucide-react'
import { api } from '../../api/client'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { useStudio } from '../../store/studio'
import StageHTMLPresetGrid from './StageHTMLPresetGrid'
import { overlayHTMLPresets } from './stageHTMLPresets'

// 允许的 MIME 类型；部分 WebView 不返回 type，因此同时按扩展名兜底判断。
const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const videoTypes = ['video/mp4', 'video/webm']
const blendModes = [
  { value: 'normal', label: '正常' },
  { value: 'screen', label: '滤色' },
  { value: 'lighten', label: '变亮' },
] as const

/** 把字节数格式化为 KB/MB 形式的展示文本。 */
function sizeLabel(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 校验上传文件，返回空字符串表示通过，否则返回错误提示。 */
function validateFile(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase()
  const isImage =
    imageTypes.includes(file.type) ||
    (!file.type && ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension || ''))
  const isVideo =
    videoTypes.includes(file.type) || (!file.type && ['mp4', 'webm'].includes(extension || ''))
  if (!isImage && !isVideo) return '请选择 PNG、JPEG、WebP、GIF 图片，或 MP4、WebM 视频。'
  if (!file.size) return '文件为空，请选择有效的图片或视频。'
  if (isImage && file.size > 15 * 1024 * 1024) return '图片大小不能超过 15 MB。'
  if (isVideo && file.size > 150 * 1024 * 1024) return '视频大小不能超过 150 MB。'
  return ''
}

export default function OverlayManager() {
  const s = useStudio()
  const input = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const uploading = useRef(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const overlayAssets = s.sceneAssets.filter((asset) => asset.kind !== 'html')
  const selected = overlayAssets.find((asset) => asset.id === s.overlayAssetID)
  const selectedPreset = overlayHTMLPresets.find((preset) => preset.id === s.overlayAssetID)
  const selectedName = selectedPreset?.name ?? selected?.name

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // 上传并自动启用；用 uploading ref 同步防重入，进度回调仅在挂载时更新状态。
  const upload = async (file?: File) => {
    if (!file || uploading.current) return
    setError('')
    setSuccess('')
    const invalid = validateFile(file)
    if (invalid) {
      setError(invalid)
      return
    }
    uploading.current = true
    setBusy(true)
    setProgress(0)
    try {
      const asset = await api.uploadSceneAsset(file, (value) => {
        if (mounted.current) setProgress(Math.max(0, Math.min(100, value)))
      })
      const state = useStudio.getState()
      state.patch({
        sceneAssets: [asset, ...state.sceneAssets.filter((item) => item.id !== asset.id)],
        overlayAssetID: asset.id,
      })
      if (mounted.current) {
        setProgress(100)
        setSuccess(`已导入并启用「${asset.name}」`)
      }
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : '导入失败，请检查服务连接后重试。')
    } finally {
      uploading.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const choose = (id: string) => {
    s.patch({ overlayAssetID: id || null })
    setError('')
    setSuccess('')
  }

  return (
    <section className="overlay-manager" aria-labelledby="overlay-manager-title">
      <div className="overlay-heading">
        <h3 id="overlay-manager-title">
          <Layers size={14} />
          前景叠加层
        </h3>
        <button
          type="button"
          className="overlay-upload-button"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? <LoaderCircle size={13} className="spin" /> : <Upload size={13} />}
          {busy ? '导入中' : '导入素材'}
        </button>
      </div>

      <StageHTMLPresetGrid
        label="动态 HTML 特效"
        presets={overlayHTMLPresets}
        selectedID={s.overlayAssetID}
        disabled={busy}
        onSelect={choose}
      />
      <div className="overlay-asset-row">
        <label className="overlay-select-label">
          <span>叠加素材</span>
          <Select
            value={selectedPreset?.id ?? selected?.id ?? 'none'}
            disabled={busy}
            onValueChange={(value) => choose(value === 'none' ? '' : value)}
          >
            <SelectTrigger size="sm" aria-label="选择自定义叠加素材" className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">不使用叠加素材</SelectItem>
              {overlayHTMLPresets.map((preset) => (
                <SelectItem value={preset.id} key={preset.id}>
                  HTML · {preset.name}
                </SelectItem>
              ))}
              {overlayAssets.map((asset) => (
                <SelectItem value={asset.id} key={asset.id}>
                  {asset.kind === 'video' ? '视频' : '图片'} · {asset.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <button
          type="button"
          className="overlay-clear-button"
          aria-label="清除自定义叠加层"
          title="停用叠加层，素材仍保留在素材库"
          disabled={busy || !s.overlayAssetID}
          onClick={() => choose('')}
        >
          <X size={13} />
          清除
        </button>
      </div>

      {selectedName && (
        <div className="overlay-selected-asset">
          <span className="overlay-asset-icon">
            {selectedPreset ? (
              <FileCode size={15} />
            ) : selected?.kind === 'video' ? (
              <Film size={15} />
            ) : (
              <Image size={15} />
            )}
          </span>
          <span className="overlay-asset-name" title={selectedName}>
            {selectedName}
          </span>
          {selected && (
            <span className="overlay-asset-size">
              {selected.mime_type === 'image/gif' ? 'GIF · ' : ''}
              {sizeLabel(selected.size)}
            </span>
          )}
        </div>
      )}
      {!!s.overlayAssetID && !selectedName && !busy && (
        <p className="overlay-status overlay-status-error" role="alert">
          找不到已选素材，请重新选择或导入。
        </p>
      )}

      <div className="overlay-adjustments">
        <label className="overlay-opacity-label">
          <span>
            叠加强度 <output>{Math.round(s.overlayOpacity * 100)}%</output>
          </span>
          <input
            type="range"
            aria-label="自定义叠加层强度"
            min="0"
            max="1"
            step="0.01"
            value={s.overlayOpacity}
            disabled={busy || !selectedName}
            onChange={(event) => s.patch({ overlayOpacity: Number(event.target.value) })}
          />
        </label>
        <label className="overlay-blend-label">
          <span>混合模式</span>
          <Select
            value={s.overlayBlendMode}
            disabled={busy || !selectedName}
            onValueChange={(value) => {
              if (value === 'normal' || value === 'screen' || value === 'lighten')
                s.patch({ overlayBlendMode: value })
            }}
          >
            <SelectTrigger size="sm" aria-label="自定义叠加层混合模式" className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {blendModes.map((mode) => (
                <SelectItem value={mode.value} key={mode.value}>
                  {mode.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      <p className="overlay-hint">黑底视频特效适合「滤色」；透明 PNG、GIF 可使用「正常」。</p>
      <p className="overlay-formats">
        图片 PNG / JPEG / WebP / GIF ≤ 15 MB · 视频 MP4 / WebM ≤ 150 MB
      </p>

      {busy && (
        <div className="overlay-progress" role="status" aria-live="polite">
          <div>
            <span>{progress >= 100 ? '上传完成，正在保存并启用…' : '正在上传素材…'}</span>
            <span>{progress}%</span>
          </div>
          <progress aria-label="叠加素材上传进度" value={progress} max="100" />
        </div>
      )}
      {error && (
        <p className="overlay-status overlay-status-error" role="alert">
          {error}
        </p>
      )}
      {success && (
        <p className="overlay-status overlay-status-success" role="status">
          <Check size={13} />
          {success}
        </p>
      )}
      <input
        ref={input}
        hidden
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,.png,.jpg,.jpeg,.webp,.gif,.mp4,.webm"
        aria-label="导入自定义叠加素材"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          void upload(file)
        }}
      />
    </section>
  )
}
