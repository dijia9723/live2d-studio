import { useCallback, useEffect, useRef } from 'react'
import { streamMessage } from '../api/stream'
import { notify, useStudio } from '../store/studio'
import type { Message } from '../types/api'

export function useChat(onReply: (text: string) => void) {
  const controller = useRef<AbortController | null>(null)
  const stop = useCallback(() => {
    controller.current?.abort()
  }, [])
  useEffect(() => stop, [stop])
  const send = useCallback(
    async (text: string, image = '') => {
      const state = useStudio.getState()
      if (!text.trim() || state.busy) return
      useStudio.setState({ busy: true, chatError: '' })
      const abort = new AbortController()
      controller.current = abort
      let pending = ''
      let full = ''
      let done = false
      let assistantID = ''
      const fail = (error: string) => {
        useStudio.setState((s) => ({
          chatError: error,
          messages: s.messages.map((m) =>
            m.id === (assistantID || pending) ? { ...m, status: 'failed', error } : m,
          ),
        }))
        notify(error)
      }
      try {
        let id = state.conversationID
        if (!id) id = (await state.newConversation()).id
        if (abort.signal.aborted) return
        const convID = id
        pending = crypto.randomUUID()
        const user: Message = {
          id: crypto.randomUUID(),
          conversation_id: id,
          role: 'user',
          content: text,
          image,
          status: 'complete',
          created_at: new Date().toISOString(),
        }
        const assistant: Message = {
          id: pending,
          conversation_id: id,
          role: 'assistant',
          content: '',
          status: 'streaming',
          created_at: new Date().toISOString(),
        }
        useStudio.setState({ messages: [...useStudio.getState().messages, user, assistant] })
        await streamMessage(id, text, image, abort.signal, (event) => {
          if (event.type === 'delta') {
            full += event.text || ''
            useStudio.setState((s) => ({
              messages: s.messages.map((m) => (m.id === pending ? { ...m, content: full } : m)),
            }))
          }
          if (event.type === 'expression')
            useStudio.getState().setMood(event.expression || 'neutral')
          if (event.type === 'done' && event.message) {
            done = true
            const message = event.message
            assistantID = message.id
            useStudio.setState((s) => ({
              messages: s.messages.map((m) => (m.id === pending ? message : m)),
            }))
            if (message.status === 'complete') onReply(message.content)
            else if (message.status === 'failed' && message.error) fail(message.error)
          }
          if (event.type === 'error') fail(event.text || '模型请求失败')
          if (event.type === 'user' && event.message) {
            const actual = event.message
            useStudio.setState((s) => ({
              messages: s.messages.map((m) => (m.id === user.id ? actual : m)),
            }))
          }
        })
        if (useStudio.getState().conversationID !== convID) return
      } catch (e) {
        const interrupted = abort.signal.aborted
        const error = e instanceof Error ? e.message : '发送失败，请检查服务连接'
        if (!interrupted) fail(error)
        if (!done)
          useStudio.setState((s) => ({
            messages: s.messages.map((m) =>
              m.id === pending
                ? {
                    ...m,
                    status: interrupted ? 'interrupted' : 'failed',
                    error: interrupted ? '' : error,
                  }
                : m,
            ),
          }))
      } finally {
        useStudio.setState({ busy: false })
        controller.current = null
        void useStudio
          .getState()
          .refreshConversations()
          .catch(() => {})
      }
    },
    [onReply],
  )
  return { send, stop }
}
