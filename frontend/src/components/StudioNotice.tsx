import { useEffect } from 'react'
import { AudioLines, X } from 'lucide-react'
import { notify, useStudio } from '../store/studio'

export default function StudioNotice() {
  const notice = useStudio((state) => state.notice)

  useEffect(() => {
    if (!notice) return
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
