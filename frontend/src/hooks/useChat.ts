/**
 * 文件职责：聊天发送流程的 Hook。
 * 负责建立会话（必要时）、占位助手消息、消费 SSE 事件更新消息、
 * 维护 busy 状态以及中断/失败时的状态收敛。
 */
import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { Live2DStageHandle } from '../components/Live2DStage'
import { streamMessage } from '../api/client'
import { notify, useStudio } from '../store/studio'
import type { Message } from '../types/api'

/**
 * @param onReply 流结束后收到完整助手回复（用于自动朗读）
 * @param stageRef 当前舞台，用于执行经过后端校验的模型动作和原生表情请求
 * @returns send：发送消息；stop：中断当前生成
 */
export function useChat(
  onReply: (text: string) => void,
  stageRef?: RefObject<Live2DStageHandle | null>,
) {
  const controller = useRef<AbortController | null>(null)
  const stop = useCallback(() => {
    controller.current?.abort()
  }, [])
  // 组件卸载时自动中断未完成的请求。
  useEffect(() => stop, [stop])

  const send = useCallback(
    async (text: string, image = '', onAccepted?: (conversationID: string) => void) => {
      const state = useStudio.getState()
      if (!text.trim() || state.busy) return
      useStudio.setState({ busy: true, chatError: '' })
      const abort = new AbortController()
      controller.current = abort
      let accepted = false
      let finished = false
      // pending 是本地占位助手消息的临时 ID，服务端返回最终消息后替换。
      let pending = ''

      // 仅对当前占位消息应用更新，避免影响其他历史消息。
      const updateReply = (update: (message: Message) => Message) => {
        useStudio.setState((studio) => ({
          messages: studio.messages.map((message) =>
            message.id === pending ? update(message) : message,
          ),
        }))
      }

      try {
        const id = state.conversationID ?? (await state.newConversation()).id
        if (abort.signal.aborted) return
        pending = crypto.randomUUID()
        await streamMessage(id, text, image, abort.signal, (event) => {
          // done 之后到达的事件一律忽略，保证幂等。
          if (finished) return
          const message = event.message
          // 第一个 user 事件表示服务端已接收消息，此时插入用户消息与空的助手占位。
          if (event.type === 'user' && message && !accepted) {
            accepted = true
            const assistant: Message = {
              id: pending,
              conversation_id: id,
              role: 'assistant',
              content: '',
              status: 'streaming',
              created_at: new Date().toISOString(),
            }
            useStudio.setState((studio) => ({ messages: [...studio.messages, message, assistant] }))
            onAccepted?.(id)
            return
          }
          if (!accepted) return
          switch (event.type) {
            case 'stage_action': {
              const action = event.stage_action
              if (!action || abort.signal.aborted) break
              const studio = useStudio.getState()
              const character =
                studio.characters.find((item) => item.id === studio.characterID) ??
                studio.characters[0]
              if (
                character?.id !== action.character_id ||
                character.model_path !== action.model_path
              ) {
                notify('当前角色已切换，已忽略之前的舞台请求')
                break
              }
              const stage = stageRef?.current
              if (!stage) {
                notify('当前舞台尚未就绪，请稍后再试')
                break
              }
              const run =
                action.type === 'motion'
                  ? stage.playMotion(action.id)
                  : action.type === 'expression'
                    ? stage.setExpression(action.id)
                    : Promise.resolve(false)
              void run
                .then((ok) => {
                  if (!abort.signal.aborted)
                    notify(
                      ok
                        ? action.type === 'motion'
                          ? '角色动作已开始播放'
                          : '模型原生表情已切换'
                        : '舞台未能执行，请检查角色是否加载完成或模型资源是否完整',
                    )
                })
                .catch(() => {
                  if (!abort.signal.aborted) notify('舞台执行失败，请检查模型资源')
                })
              break
            }
            case 'delta':
              updateReply((reply) => ({ ...reply, content: reply.content + (event.text ?? '') }))
              break
            case 'expression':
              useStudio.getState().setMood(event.expression || 'neutral')
              break
            case 'character': {
              const character = event.character
              if (character)
                useStudio.setState((studio) => ({
                  characters: studio.characters.map((item) =>
                    item.id === character.id ? character : item,
                  ),
                }))
              break
            }
            case 'tool': {
              const tool = event.tool
              if (tool)
                updateReply((reply) => {
                  // 同一工具多次上报时按 id 合并，否则追加。
                  const runs = reply.tool_runs ?? []
                  const tool_runs = runs.some((run) => run.id === tool.id)
                    ? runs.map((run) => (run.id === tool.id ? tool : run))
                    : [...runs, tool]
                  return { ...reply, tool_runs }
                })
              break
            }
            case 'done':
              if (message) {
                finished = true
                updateReply(() => message)
                // 仅正常完成且未被用户中断时触发朗读。
                if (message.status === 'complete' && !abort.signal.aborted) onReply(message.content)
              }
              break
          }
        })
      } catch (cause) {
        if (finished) return
        const interrupted = abort.signal.aborted
        const error = cause instanceof Error ? cause.message : '发送失败，请检查服务连接'
        // 占位消息出现之前失败：显示在输入区；之后失败：标记消息本身状态。
        if (!interrupted && !accepted) useStudio.setState({ chatError: error })
        if (accepted)
          updateReply((reply) => ({
            ...reply,
            status: interrupted ? 'interrupted' : 'failed',
            error: interrupted ? '' : error,
          }))
      } finally {
        controller.current = null
        useStudio.setState({ busy: false })
        // 后台刷新会话列表以更新标题/时间，失败可忽略。
        void useStudio
          .getState()
          .refreshConversations()
          .catch(() => {})
      }
    },
    [onReply, stageRef],
  )
  return { send, stop }
}
