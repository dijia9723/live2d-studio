import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { LATEST_PROTOCOL_VERSION } from '@earendil-works/pi-mcp'

function respondWithTool(response, name, arguments_, step) {
  const delta = {
    role: 'assistant',
    tool_calls: [{ index: 0, id: `tool_${step}`, type: 'function', function: {
      name, arguments: JSON.stringify(arguments_),
    } }],
  }
  respond(response, delta, 'tool_calls')
}

function respond(response, delta, finish) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const [content, reason] of [[delta, null], [{}, finish]]) {
    response.write(`data: ${JSON.stringify({
      id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', created: 1,
      choices: [{ index: 0, delta: content, finish_reason: reason }],
    })}\n\n`)
  }
  response.end('data: [DONE]\n\n')
}

test('Pi loads a plugin Skill on demand and restricts MCP and trusted extensions to coding mode', { timeout: 30_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'pi-studio-test-'))
  const extension = join(tmp, 'fixture.mjs')
  const marker = 'Trusted local extension fixture.'
  const calls = []
  let mode
  const failures = []
  const skill = { id: 'test.plugin/release', name: 'Release notes', description: 'Use for releases', body: 'Read the release checklist.' }
  const fixture = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      if (request.url === '/mcp') {
        calls.push(body.method ?? request.method)
        assert.equal(mode, 'agent')
        assert.equal(request.headers.authorization, 'Bearer fixture-mcp')
        if (request.method === 'DELETE') {
          assert.equal(request.headers['mcp-session-id'], 'fixture-session')
          response.writeHead(204).end()
          return
        }
        if (!body.id) {
          response.writeHead(202).end()
          return
        }
        let result
        switch (body.method) {
          case 'initialize':
            result = { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'Fixture', version: '1' } }
            break
          case 'tools/list':
            result = { tools: [{ name: 'echo', description: 'Echo fixture', inputSchema: { type: 'object' } }] }
            break
          case 'tools/call':
            assert.deepEqual(body.params, { name: 'echo', arguments: { text: 'hello' } })
            result = { content: [{ type: 'text', text: 'fixture-echo Bearer fixture-mcp' }] }
            break
          default:
            throw new Error('unexpected MCP method')
        }
        response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
        return
      }
      assert.equal(request.url, '/v1/chat/completions')
      assert.equal(request.headers.authorization, 'Bearer fixture-model')
      assert.ok(!JSON.stringify(body).includes('fixture-mcp'))
      const names = body.tools.map((tool) => tool.function.name)
      assert.ok(names.includes('plugin_skill'))
      assert.equal(names.includes('plugin_mcp'), mode === 'agent')
      assert.equal(names.includes('write_file'), mode === 'agent')
      assert.equal(body.messages.some((message) => message.role === 'system' && message.content.includes(marker)), mode === 'agent')
      const results = body.messages.filter((message) => message.role === 'tool')
      if (results.length === 0) {
        assert.ok(!JSON.stringify(body).includes(skill.body))
        respondWithTool(response, 'plugin_skill', { id: skill.id }, 0)
      } else if (mode === 'agent' && results.length === 1) {
        assert.ok(JSON.stringify(results).includes(skill.body))
        respondWithTool(response, 'plugin_mcp', { server: 'test.plugin/fixture', action: 'list_tools' }, 1)
      } else if (mode === 'agent' && results.length === 2) {
        assert.ok(JSON.stringify(results).includes('Echo fixture'))
        respondWithTool(response, 'plugin_mcp', {
          server: 'test.plugin/fixture', action: 'call_tool', name: 'echo', arguments: { text: 'hello' },
        }, 2)
      } else {
        assert.ok(JSON.stringify(results).includes(mode === 'agent' ? 'fixture-echo' : skill.body))
        respond(response, { role: 'assistant', content: 'done' }, 'stop')
      }
    } catch (error) {
      failures.push(error)
      response.writeHead(500).end()
    }
  })
  fixture.listen(0, '127.0.0.1')
  await once(fixture, 'listening')
  const base = `http://127.0.0.1:${fixture.address().port}`
  try {
    await writeFile(extension, `export default (pi) => {
      pi.on('before_agent_start', (event) => ({ systemPrompt: event.systemPrompt + '\\n' + ${JSON.stringify(marker)} }));
    };`)
    for (mode of ['plan', 'agent']) {
      const worker = new URL('./worker.mjs', import.meta.url)
      const child = spawn(process.execPath, [fileURLToPath(worker)], { cwd: fileURLToPath(new URL('.', worker)) })
      const lines = createInterface({ input: child.stdout })
      const events = []
      lines.on('line', (line) => {
        const event = JSON.parse(line)
        events.push(event)
        if (event.type === 'error' || event.type === 'done') child.stdin.end()
      })
      child.stdin.write(JSON.stringify({
        model: { api_key: 'fixture-model', base_url: `${base}/v1`, model: 'fixture', max_tokens: 1024 },
        mode, prompt: 'Summarize the release instructions.', session_file: join(tmp, `${mode}.jsonl`),
        trusted_extensions: [extension], project_path: tmp,
        plugins: {
          skills: [skill],
          mcp: [{ id: 'test.plugin/fixture', url: `${base}/mcp`, local: true, headers: { Authorization: 'Bearer fixture-mcp' } }],
        },
      }) + '\n')
      const [code] = await once(child, 'close')
      assert.deepEqual(failures, [])
      assert.equal(code, 0, JSON.stringify(events))
      assert.ok(events.some((event) => event.type === 'done'), JSON.stringify(events))
      assert.ok(events.some((event) => event.type === 'plugin_tool' && event.name === 'plugin_skill'))
      assert.equal(events.some((event) => event.type === 'plugin_tool' && event.name === 'plugin_mcp'), mode === 'agent')
    }
    assert.deepEqual(calls, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'DELETE'])
  } finally {
    fixture.close()
    await rm(tmp, { recursive: true, force: true })
  }
})
