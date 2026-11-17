import assert from 'node:assert/strict'
import test from 'node:test'
import { SSEDecoder } from '../src/utils/sse.ts'

test('decodes LF and CRLF frames even when split between every character', () => {
  const received = []
  const parser = new SSEDecoder((value) => received.push(JSON.parse(value)))
  const source =
    ': ping\r\nevent: message\r\ndata:{"type":"delta","text":"你好"}\r\n\r\ndata: {"type":"done"}\n\n'
  for (const character of source) parser.push(character)
  parser.finish()
  assert.deepEqual(received, [{ type: 'delta', text: '你好' }, { type: 'done' }])
})

test('handles multiline data, ignores comments, and emits final unterminated frame', () => {
  const received = []
  const parser = new SSEDecoder((value) => received.push(value))
  parser.push(': keepalive\n\ndata: {"type":\n')
  parser.push('data: "error","text":"连接失败"}')
  parser.finish()
  assert.deepEqual(received.map(JSON.parse), [{ type: 'error', text: '连接失败' }])
})

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
