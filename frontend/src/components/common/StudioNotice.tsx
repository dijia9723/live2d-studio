/**
 * 文件职责：全局轻提示（Toast）。
 * 展示 store 中的 notice 文案，5 秒后自动消失，也支持手动关闭。
 */
import { useEffect } from 'react'
import { AudioLines, X } from 'lucide-react'
import { notify, useStudio } from '../../store/studio'

/** 全局提示条。 */
export default function StudioNotice() {
  const notice = useStudio((state) => state.notice)

  useEffect(() => {
    if (!notice) return
    // notice 变化会重置计时，连续提示不会过早消失。
    const timer = setTimeout(() => notify(''), 5000)
    return () => clearTimeout(timer)
  }, [notice])

  if (!notice) return null
  return (
    <div className="toast" role="status">
      <AudioLines size={18} />
      <span>{notice}</span>
      <button aria-label="关闭提示" onClick={() => notify('')}>
        <X size={15} />
      </button>
    </div>
  )
}
