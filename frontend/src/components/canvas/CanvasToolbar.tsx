/** 文件职责：画布内的插入菜单与布局编辑开关。 */
import { Braces, Check, MousePointer2, Plus, SlidersHorizontal, Type } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { useCanvas } from '../../store/canvas'
import { maxCanvasWidgets } from '../../utils/canvas'

/** onOpen 打开右侧组件管理。 */
export default function CanvasToolbar({ onOpen }: { onOpen: () => void }) {
  const s = useCanvas()
  const add = (kind: 'title' | 'html') => {
    s.addWidget(kind)
    onOpen()
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="icon-button glass"
            aria-label="插入画布元素"
            title="插入标题或计数组件"
          >
            <Plus size={17} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={s.widgets.length >= maxCanvasWidgets}
            onSelect={() => add('title')}
          >
            <Type size={15} />
            插入标题
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={s.widgets.length >= maxCanvasWidgets}
            onSelect={() => add('html')}
          >
            <Braces size={15} />
            插入 HTML 计数组件
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpen}>
            <SlidersHorizontal size={15} />
            管理组件与计数数据
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {!!s.widgets.length && (
        <button
          className="icon-button glass"
          aria-label={s.editing ? '完成布局编辑' : '编辑画布布局'}
          title={s.editing ? '完成布局编辑' : '编辑画布布局'}
          aria-pressed={s.editing}
          onClick={() => {
            s.setEditing(!s.editing)
            if (!s.editing) onOpen()
          }}
        >
          {s.editing ? <Check size={17} /> : <MousePointer2 size={17} />}
        </button>
      )}
    </>
  )
}
