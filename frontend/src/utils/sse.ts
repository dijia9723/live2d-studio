/**
 * 文件职责：SSE（text/event-stream）增量解析器。
 * 只负责按行切分并聚合 data 字段，不处理业务 JSON 语义。
 */

/** 增量解码 SSE 行，并兼容被网络分块拆开的 CRLF。 */
export class SSEDecoder {
  private buffer = ''
  private data: string[] = []
  // 上一个 chunk 以 \r 结尾时，下一个 chunk 开头的 \n 需要被吞掉。
  private skipLF = false
  private readonly emit: (data: string) => void

  constructor(emit: (data: string) => void) {
    this.emit = emit
  }

  /** 追加一个已解码的文本块；行尾未完整时留在 buffer 中等待下一个 chunk。 */
  push(chunk: string) {
    for (const character of chunk) {
      if (this.skipLF) {
        this.skipLF = false
        if (character === '\n') continue
      }
      if (character === '\r' || character === '\n') {
        this.line(this.buffer)
        this.buffer = ''
        this.skipLF = character === '\r'
      } else this.buffer += character
    }
  }

  /** 流结束时调用：冲刷剩余半行并派发尚未发送的事件。 */
  finish() {
    if (this.buffer) this.line(this.buffer)
    this.buffer = ''
    this.dispatch()
  }

  // 空行代表一个事件结束；只收集 data: 行，其余字段（event/id/retry）忽略。
  private line(line: string) {
    if (!line) this.dispatch()
    else if (line.startsWith('data:')) {
      const value = line.slice(5)
      this.data.push(value.startsWith(' ') ? value.slice(1) : value)
    }
  }

  // 多行 data 之间以换行拼接后一次性回调。
  private dispatch() {
    if (!this.data.length) return
    const value = this.data.join('\n')
    this.data = []
    this.emit(value)
  }
}
