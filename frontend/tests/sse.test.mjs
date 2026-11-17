/**
 * 文件职责：SSE 解析器单元测试。
 * 覆盖分块边界、CRLF、注释行与跨字节 UTF-8 解码。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { SSEDecoder } from '../src/utils/sse.ts'

// 场景：逐字符喂入 LF/CRLF 混合帧（模拟任意分块边界）仍能正确解析。
test('decodes LF and CRLF frames even when split between every character', () => {
  const received = []
  const parser = new SSEDecoder((value) => received.push(JSON.parse(value)))
  const source =
    ': ping\r\nevent: message\r\ndata:{"type":"delta","text":"你好"}\r\n\r\ndata: {"type":"done"}\n\n'
  for (const character of source) parser.push(character)
  parser.finish()
  assert.deepEqual(received, [{ type: 'delta', text: '你好' }, { type: 'done' }])
})

// 场景：多行 data 需要拼接成一条事件，注释行被忽略，流结束时冲刷无空行结尾的帧。
test('handles multiline data, ignores comments, and emits final unterminated frame', () => {
  const received = []
  const parser = new SSEDecoder((value) => received.push(value))
  parser.push(': keepalive\n\ndata: {"type":\n')
  parser.push('data: "error","text":"连接失败"}')
  parser.finish()
  assert.deepEqual(received.map(JSON.parse), [{ type: 'error', text: '连接失败' }])
})

// 场景：传输层把一个中文字符拆成多个字节时，增量解码仍能还原完整文本。
test('preserves UTF-8 deltas when transport bytes split inside Chinese characters', () => {
  const received = []
  const parser = new SSEDecoder((value) => received.push(JSON.parse(value)))
  const decoder = new TextDecoder()
  for (const byte of new TextEncoder().encode('data: {"type":"delta","text":"陪伴 ✨"}\n\n')) {
    parser.push(decoder.decode(Uint8Array.of(byte), { stream: true }))
  }
  parser.push(decoder.decode())
  parser.finish()
  assert.equal(received[0].text, '陪伴 ✨')
})
