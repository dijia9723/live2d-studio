/** 文件职责：画布标题、HTML 组件及共享计数数据的类型。 */

export interface CanvasCounter {
  id: string
  name: string
  mode: 'manual' | 'auto'
  value: number
  initialValue: number
  step: number
  intervalSeconds: number
  running: boolean
  startedAt: number
}

export interface CanvasBinding {
  id: string
  alias: string
  counterID: string
}

export interface CanvasRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CanvasWidget extends CanvasRect {
  id: string
  kind: 'title' | 'html'
  name: string
  visible: boolean
  locked: boolean
  opacity: number
  text: string
  fontSize: number
  color: string
  bold: boolean
  align: 'left' | 'center' | 'right'
  html: string
  bindings: CanvasBinding[]
}
