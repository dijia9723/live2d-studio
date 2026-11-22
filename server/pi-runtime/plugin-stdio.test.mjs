import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LATEST_PROTOCOL_VERSION } from '@earendil-works/pi-mcp'
import { createPluginMCP } from './plugin-mcp.mjs'

test('approved MCP stdio uses the supplied environment and exits when closed', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-mcp-stdio-'))
  const executable = join(dir, 'fixture.mjs')
  await writeFile(executable, `
    import { createInterface } from 'node:readline'
    import { writeFileSync } from 'node:fs'
    const lines = createInterface({ input: process.stdin })
    lines.on('line', (line) => {
      const { id, method } = JSON.parse(line)
      if (!id) return
      const result = method === 'initialize'
        ? { protocolVersion: ${JSON.stringify(LATEST_PROTOCOL_VERSION)}, serverInfo: { name: 'Fixture', version: '1' }, capabilities: { tools: {} } }
        : { tools: [{ name: 'fixture', description: 'stdio fixture ' + process.env.VALUE, inputSchema: { type: 'object' } }] }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
    })
    lines.on('close', () => writeFileSync('exited.txt', String(process.env.STUDIO_STDIO_PARENT_FIXTURE ?? 'isolated')))
  `)
  const expectedSecret = 'temporary-value'
  const previous = process.env.STUDIO_STDIO_PARENT_FIXTURE
  process.env.STUDIO_STDIO_PARENT_FIXTURE = 'must-not-inherit'
  const events = []
  const mcp = createPluginMCP([{
    id: 'test.stdio/fixture',
    command: process.execPath, args: [executable], cwd: dir,
    env: { VALUE: expectedSecret, SYSTEMROOT: process.env.SYSTEMROOT ?? '' },
    redact: [expectedSecret],
  }], (event) => events.push(event))
  try {
    const result = await mcp.tool.execute('call', { server: 'test.stdio/fixture', action: 'list_tools' })
    assert.ok(result.content[0].text.includes('stdio fixture [redacted]'))
    assert.ok(!result.content[0].text.includes(expectedSecret))
    assert.equal(events[0].name, 'plugin_mcp')
    await mcp.close()
    assert.equal(await readFile(join(dir, 'exited.txt'), 'utf8'), 'isolated')
  } finally {
    if (previous !== undefined) process.env.STUDIO_STDIO_PARENT_FIXTURE = previous
    else delete process.env.STUDIO_STDIO_PARENT_FIXTURE
    await mcp.close()
    await rm(dir, { recursive: true, force: true })
  }
})
