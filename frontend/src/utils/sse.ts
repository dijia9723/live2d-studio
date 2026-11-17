/** Decode SSE lines incrementally, including CRLF split between network chunks. */
export class SSEDecoder {
  private buffer = ''
  private data: string[] = []
  private skipLF = false
  private readonly emit: (data: string) => void

  constructor(emit: (data: string) => void) {
    this.emit = emit
  }

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

  finish() {
    if (this.buffer) this.line(this.buffer)
    this.buffer = ''
    this.dispatch()
  }

  private line(line: string) {
    if (!line) this.dispatch()
    else if (line.startsWith('data:')) {
      const value = line.slice(5)
      this.data.push(value.startsWith(' ') ? value.slice(1) : value)
    }
  }

  private dispatch() {
    if (!this.data.length) return
    const value = this.data.join('\n')
    this.data = []
    this.emit(value)
  }
}
