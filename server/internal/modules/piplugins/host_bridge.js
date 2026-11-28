(() => {
  'use strict'
  let token = ''
  let next = 0
  const pending = new Map()
  const listeners = new Map()
  const ready = []

  const send = (request) => parent.postMessage({
    type: 'studio-plugin-invoke',
    token,
    id: request.id,
    method: request.method,
    payload: request.payload,
  }, '*')

  addEventListener('message', (event) => {
    if (event.source !== parent || !event.data || typeof event.data !== 'object') return
    const data = event.data
    if (data.type === 'studio-plugin-init' && !token && typeof data.token === 'string' && data.token.length >= 12) {
      token = data.token
      ready.splice(0).forEach(send)
      return
    }
    if (!token || data.token !== token) return
    if (data.type === 'studio-plugin-reply') {
      const request = pending.get(data.id)
      if (!request) return
      pending.delete(data.id)
      clearTimeout(request.timer)
      if (data.ok) request.resolve(data.value)
      else request.reject(new Error(typeof data.error === 'string' ? data.error : 'Plugin bridge call failed'))
      return
    }
    if (data.type === 'studio-plugin-event') {
      for (const listener of listeners.get(data.event) ?? []) listener(data.payload)
    }
  })

  function invoke(method, payload) {
    if (typeof method !== 'string' || method.length > 128 || pending.size >= 16) {
      return Promise.reject(new Error('Invalid or excessive plugin bridge calls'))
    }
    return new Promise((resolve, reject) => {
      const id = ++next
      const timer = setTimeout(() => {
        pending.delete(id)
        const queued = ready.findIndex((request) => request.id === id)
        if (queued >= 0) ready.splice(queued, 1)
        reject(new Error('Plugin bridge call timed out'))
      }, 8_000)
      pending.set(id, { resolve, reject, timer })
      const request = { id, method, payload }
      if (token) send(request)
      else ready.push(request)
    })
  }

  function on(event, listener) {
    if (typeof event !== 'string' || typeof listener !== 'function' || listeners.size >= 20) return () => {}
    const group = listeners.get(event) ?? new Set()
    group.add(listener)
    listeners.set(event, group)
    return () => group.delete(listener)
  }

  Object.defineProperty(window, 'pluginBridge', { value: Object.freeze({ invoke, on }) })
})()
