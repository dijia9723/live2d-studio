(() => {
  'use strict'

  const parse = JSON.parse
  const stringify = JSON.stringify
  const now = Date.now
  const commands = new Map()
  const tools = new Map()
  const services = new Map()
  const subscriptions = new Map()
  const timers = new Map()
  const started = new Set()
  const noop = () => {}
  let queue = []
  let spec
  let manifest
  let settings
  let storage
  let plugin
  let nextTimer = 0

  function packageRequire(initial, files) {
    const cache = new Map()
    const candidates = ['', '.js', '.cjs', '.json', '/index.js', '/index.cjs', '/index.json']
    const from = (filename) => {
      function resolve(name) {
        if (typeof name !== 'string' || !/^\.{1,2}\//.test(name) || name.includes('\\')) {
          throw new Error('Only plugin-relative JavaScript and JSON modules are supported')
        }
        const segments = filename.split('/').slice(0, -1)
        for (const part of name.split('/')) {
          if (!part || part === '.') continue
          if (part === '..') {
            if (!segments.length) throw new Error('Plugin module leaves the package')
            segments.pop()
          } else {
            segments.push(part)
          }
        }
        const base = segments.join('/')
        for (const suffix of candidates) {
          if (Object.hasOwn(files, base + suffix)) return base + suffix
        }
        throw new Error('Plugin-relative module was not found')
      }
      const load = (name) => {
        const entry = resolve(name)
        if (cache.has(entry)) return cache.get(entry).exports
        const module = { exports: {} }
        cache.set(entry, module)
        try {
          if (entry.endsWith('.json')) {
            module.exports = parse(files[entry])
          } else {
            const run = new Function('module', 'exports', 'require', '__filename', '__dirname', files[entry])
            run(module, module.exports, from(entry), entry, entry.split('/').slice(0, -1).join('/') || '.')
          }
        } catch (error) {
          cache.delete(entry)
          throw error
        }
        return module.exports
      }
      return Object.freeze(Object.assign(load, { resolve }))
    }
    return from(initial)
  }

  function emit(event) {
    if (queue.length >= 48 || stringify(event).length > 32_768) return
    queue.push(event)
  }

  function apiLocked(target) {
    Object.freeze(target)
    return target
  }

  function allowed(category, value, key = 'id') {
    return spec[category].some((declaration) => declaration[key] === value)
  }

  function registration(category, store, value, key = 'id') {
    if (!allowed(category, value?.[key], key)) {
      throw new Error('Plugin member must be declared in the manifest')
    }
    store.set(value[key], value)
  }

  function validName(key) {
    return typeof key === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(key)
  }

  function writeStorage(kind, next) {
    const value = stringify(next)
    if (value.length > 32_000) throw new Error('Plugin data is too large')
    emit({ type: kind, data: parse(value) })
  }

  function setSettings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('Settings must be an object')
    }
    const next = { ...settings }
    for (const [key, value] of Object.entries(patch)) {
      if (validName(key) && allowed('settings', key, 'key')) next[key] = value
    }
    settings = next
    writeStorage('settings', settings)
    return true
  }

  function topicMatches(pattern, topic) {
    if (pattern.endsWith('.**')) {
      const prefix = pattern.slice(0, -3)
      return topic === prefix || topic.startsWith(prefix + '.')
    }
    const parts = pattern.split('.')
    const values = topic.split('.')
    return parts.length === values.length && parts.every((part, index) => part === '*' || part === values[index])
  }

  function registerTimer(callback, delay, repeat, args) {
    if (typeof callback !== 'function' || timers.size >= 64) throw new Error('Invalid plugin timer')
    const duration = Math.max(100, Math.min(86_400_000, Number(delay) || 0))
    const id = ++nextTimer
    timers.set(id, { callback, duration, repeat, args, at: now() + duration })
    return id
  }

  function tick() {
    const time = now()
    let count = 0
    for (const [id, timer] of timers) {
      if (timer.at > time || count++ >= 16) continue
      if (timer.repeat) timer.at = time + timer.duration
      else timers.delete(id)
      try {
        const status = timer.callback(...timer.args)
        if (status?.catch) status.catch(noop)
      } catch {
        emit({ type: 'diagnostic', text: '插件定时任务执行失败' })
      }
    }
  }

  function showToast(options) {
    const text = String(options?.message ?? options?.text ?? options ?? '').trim().slice(0, 400)
    if (text) emit({ type: 'toast', text })
    return true
  }

  function addGlobals(completion, models) {
    async function workspaceCall(workspaceMethod, payload) {
      const result = parse(completion(stringify({ workspaceMethod, payload })))
      if (result.error) throw new Error(result.error)
      return result.value
    }
    const ui = apiLocked({
      showToast,
      openPanel(options) {
        if (!allowed('views', 'panel')) throw new Error('Plugin does not declare a panel')
        emit({ type: 'panel', id: 'panel', title: String(options?.title ?? '').slice(0, 160) })
        return true
      },
      openView(id) {
        if (!allowed('views', id)) throw new Error('Plugin does not declare this view')
        emit({ type: 'panel', id })
        return true
      },
    })
    const api = apiLocked({
      app: apiLocked({
        getVersion: () => '0.24.0',
        getLocale: () => 'zh-CN',
        getAppearance: () => 'dark',
      }),
      plugin: apiLocked({
        getId: () => spec.id,
        getManifest: () => parse(stringify(manifest)),
        getSettings: () => parse(stringify(settings)),
        setSettings,
        getDataPath: () => null,
      }),
      storage: apiLocked({
        get(key) { return Object.hasOwn(storage, key) ? parse(stringify(storage[key])) : undefined },
        set(key, value) {
          if (!validName(key) || value === undefined) throw new Error('Invalid plugin storage key or value')
          const next = { ...storage, [key]: value }
          writeStorage('storage', next)
          storage = next
        },
        delete(key) {
          const next = { ...storage }
          delete next[key]
          writeStorage('storage', next)
          storage = next
        },
      }),
      ui,
      workspace: apiLocked({ get: () => workspaceCall('workspace.get') }),
      projects: apiLocked({ list: () => workspaceCall('projects.list') }),
      session: apiLocked({
        getActive: () => workspaceCall('session.getActive'),
        listMessages: (options) => workspaceCall('session.listMessages', options),
      }),
      fs: apiLocked({
        list: (path, options) => workspaceCall('fs.list', { path, workspacePath: options?.workspacePath }),
        readText: (path) => workspaceCall('fs.readText', { path }),
        stat: (path) => workspaceCall('fs.stat', { path }),
        readPreview: (path, options) => workspaceCall('fs.readPreview', { path, workspacePath: options?.workspacePath }),
      }),
      commands: apiLocked({
        register(value) {
          if (typeof value?.run !== 'function') throw new Error('Command callback is required')
          registration('commands', commands, value)
        },
        unregister(id) { commands.delete(id) },
      }),
      agent: apiLocked({
        registerTool(value) {
          if (typeof value?.execute !== 'function') throw new Error('Tool callback is required')
          registration('tools', tools, value, 'name')
        },
        unregisterTool(name) { tools.delete(name) },
        async complete(options) {
          if (!spec.permissions?.includes('agent.complete')) {
            throw new Error('Plugin does not have model completion permission')
          }
          const reply = parse(completion(stringify(options)))
          if (reply.error) throw new Error(reply.error)
          return { text: reply.text || '' }
        },
      }),
      models: apiLocked({
        async list() {
          if (!spec.permissions?.includes('models.list')) {
            throw new Error('Plugin does not have model listing permission')
          }
          return parse(stringify(models))
        },
      }),
      services: apiLocked({
        register(value) {
          if (typeof value?.start !== 'function') throw new Error('Service start callback is required')
          registration('services', services, value)
        },
      }),
      bus: apiLocked({
        publish(topic, data) {
          if (!validName(topic) || !spec.bus.publish?.some((pattern) => topicMatches(pattern, topic))) {
            throw new Error('Plugin cannot publish this topic')
          }
          emit({ type: 'bus', topic, data })
          return true
        },
        subscribe(pattern, callback) {
          if (!spec.bus.subscribe?.includes(pattern) || typeof callback !== 'function') {
            throw new Error('Plugin cannot subscribe to this topic')
          }
          subscriptions.set(pattern, callback)
          return () => subscriptions.delete(pattern)
        },
      }),
    })
    Object.defineProperties(globalThis, {
      pi: { value: api },
      console: { value: apiLocked({ log: noop, debug: noop, info: noop, warn: noop, error: noop }) },
      setTimeout: { value: (callback, delay, ...args) => registerTimer(callback, delay, false, args) },
      setInterval: { value: (callback, delay, ...args) => registerTimer(callback, delay, true, args) },
      clearTimeout: { value: (id) => timers.delete(id) },
      clearInterval: { value: (id) => timers.delete(id) },
    })
  }

  globalThis.__piPrepare = (input, completion) => {
    const config = parse(input)
    spec = config.spec
    manifest = config.manifest
    settings = config.settings
    storage = config.storage
    addGlobals(completion, config.models ?? [])
    globalThis.module = { exports: {} }
    globalThis.exports = globalThis.module.exports
    globalThis.require = packageRequire(config.main, config.modules ?? {})
    globalThis.__filename = config.main
    globalThis.__dirname = config.main.split('/').slice(0, -1).join('/') || '.'
  }

  globalThis.__piSettle = async (operation, raw) => {
    const input = parse(raw)
    let result
    switch (operation) {
      case 'load':
        plugin = globalThis.module.exports
        await plugin?.onLoad?.()
        for (const [id, service] of services) {
          await service.start({ log: noop })
          started.add(id)
        }
        break
      case 'command': {
        const command = commands.get(input.id)
        if (!command) throw new Error('Plugin command did not register')
        result = await command.run()
        break
      }
      case 'tool': {
        const tool = tools.get(input.id)
        if (!tool) throw new Error('Plugin tool did not register')
        result = await tool.execute(input.payload)
        break
      }
      case 'panel':
        if (typeof plugin?.onPanelInvoke !== 'function') throw new Error('Plugin panel channel is unavailable')
        result = await plugin.onPanelInvoke(input.id, input.payload)
        break
      case 'bus':
        for (const [pattern, callback] of subscriptions) {
          if (topicMatches(pattern, input.id)) {
            await callback({ topic: input.id, from: input.from, payload: input.payload })
          }
        }
        break
      case 'settings':
        settings = input.payload
        await plugin?.onSettingsChanged?.(parse(stringify(settings)))
        break
      case 'shutdown':
        for (const id of started) {
          try { await services.get(id)?.stop?.() } catch {}
        }
        timers.clear()
        await plugin?.onUnload?.()
        break
      default:
        throw new Error('Unknown plugin host operation')
    }
    return stringify(result ?? null)
  }

  globalThis.__piTick = tick
  globalThis.__piDrain = () => {
    const events = queue
    queue = []
    return stringify(events)
  }
})()
