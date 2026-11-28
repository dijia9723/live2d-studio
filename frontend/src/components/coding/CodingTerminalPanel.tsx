/**
 * CodingTerminalPanel 基于 xterm.js 渲染项目终端：通过 HTTP 流式接口与后端 PTY 连接，
 * 负责输入回显、会话重连、尺寸同步与退出状态展示。
 */
import { useEffect, useRef, useState } from 'react'
import { Play, Square, Terminal as TerminalIcon } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { codingTerminalAPI, type TerminalSize } from '../../api/codingTerminal'
import type { CodingProject } from '../../api/coding'
import '@xterm/xterm/css/xterm.css'
import '../../assets/coding-terminal.css'

/** Phase 终端的生命周期状态，用于切换工具栏按钮与状态文案。 */
type Phase = 'idle' | 'starting' | 'running' | 'reconnecting' | 'stopping' | 'exited'
/** Connection 一次终端连接的可变状态，放在 ref 中避免流式回调读到过期闭包。 */
type Connection = {
  id: string
  abort: AbortController
  /** 已消费到的输出游标，重连时从该位置续传。 */
  cursor: number
  /** 流是否已建立，未就绪时输入先进入待发送缓冲。 */
  ready: boolean
  /** 用户主动停止中，重连逻辑需跳过。 */
  stopping: boolean
  /** 等待发送的键盘输入。 */
  text: string
  /** 是否正在发送缓冲，防止并发写入。 */
  writing: boolean
}

const STATUS: Record<Phase, string> = {
  idle: '未启动',
  starting: '正在启动',
  running: '运行中',
  reconnecting: '正在重连',
  stopping: '正在停止',
  exited: '已退出',
}

/** sized 将终端尺寸限制在后端可接受的范围内。 */
const sized = ({ cols, rows }: TerminalSize) => ({
  cols: Math.max(2, Math.min(500, cols)),
  rows: Math.max(2, Math.min(300, rows)),
})

/** errorMessage 将未知异常转换为可展示的中文错误。 */
function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : '终端操作失败'
}

/** pause 可被 AbortSignal 提前打断的延时，用于重连退避。 */
function pause(duration: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = window.setTimeout(finish, duration)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}

/** CodingTerminalPanel 项目终端面板；visible 只控制显示，不销毁已有终端会话。 */
export default function CodingTerminalPanel({
  project,
  visible = true,
}: {
  /** 当前编码项目。 */
  project: CodingProject
  /** 是否显示面板。 */
  visible?: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal>(null)
  const fitAddon = useRef<FitAddon>(null)
  const connection = useRef<Connection>(null)
  // generation 在终端重建时自增，用于丢弃属于旧实例的异步结果。
  const generation = useRef(0)
  const [phase, setPhase] = useState<Phase>('idle')
  const [exitCode, setExitCode] = useState<number>()
  const [error, setError] = useState('')

  useEffect(() => {
    if (!host.current) return
    const element = host.current
    const xterm = new Terminal({
      cursorBlink: true,
      fontFamily: "'IBM Plex Mono', Consolas, monospace",
      fontSize: 12,
      scrollback: 4000,
      theme: { background: '#151318', foreground: '#e7deea', cursor: '#e3cced' },
      linkHandler: {
        activate: (_event, address) => {
          try {
            const url = new URL(address)
            if (url.protocol === 'http:' || url.protocol === 'https:') {
              window.open(url.href, '_blank', 'noopener,noreferrer')
            }
          } catch {
            // Ignore malformed addresses in terminal output.
          }
        },
      },
    })
    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.open(element)
    xterm.textarea?.setAttribute('aria-label', '终端输入')
    // 拦截 OSC 52（写剪贴板）序列并直接吞掉，防止终端输出悄悄改写系统剪贴板。
    xterm.parser.registerOscHandler(52, () => true)
    fitAddon.current = fit
    terminal.current = xterm
    fit.fit()

    let resizeTimer = 0
    const monitor = new ResizeObserver(() => {
      if (element.clientWidth && element.clientHeight) fit.fit()
    })
    monitor.observe(element)
    xterm.onResize((size) => {
      clearTimeout(resizeTimer)
      // 拖拽窗口时尺寸会连续变化，120ms 防抖后再同步到后端 PTY。
      resizeTimer = window.setTimeout(() => {
        const item = connection.current
        if (item?.ready)
          void codingTerminalAPI.resize(project.id, item.id, sized(size)).catch(() => {})
      }, 120)
    })

    const flushInput = async (item: Connection) => {
      // writing 标记保证同一连接同时只有一个发送循环，避免输入乱序。
      if (item.writing) return
      item.writing = true
      try {
        while (item.text && item.ready && !item.abort.signal.aborted) {
          let count = Math.min(item.text.length, 4096)
          const last = item.text.charCodeAt(count - 1)
          // 按 UTF-16 码元切分可能把代理对拆开，末尾是高位代理时回退一位。
          if (count < item.text.length && last >= 0xd800 && last <= 0xdbff) count--
          const part = item.text.slice(0, count)
          item.text = item.text.slice(count)
          await codingTerminalAPI.input(project.id, item.id, part)
        }
      } catch (cause) {
        if (!item.abort.signal.aborted) setError(errorMessage(cause))
        item.text = ''
      } finally {
        item.writing = false
      }
    }
    xterm.onData((text) => {
      const item = connection.current
      if (!item?.ready) return
      // 限制待发送缓冲（64K 字符）避免一次性粘贴超大内容打爆请求体。
      if (item.text.length + text.length > 64 << 10) {
        setError('粘贴的终端输入过长，请分段发送')
        return
      }
      item.text += text
      void flushInput(item)
    })
    return () => {
      // 自增 generation 让 start() 中的异步流程识别出组件已重建。
      generation.current++
      monitor.disconnect()
      clearTimeout(resizeTimer)
      const item = connection.current
      connection.current = null
      if (item) {
        item.abort.abort()
        // 强制结束后端 PTY，避免切换项目后遗留孤儿进程。
        void codingTerminalAPI.stop(project.id, item.id, true).catch(() => {})
      }
      terminal.current = null
      fitAddon.current = null
      xterm.dispose()
    }
  }, [project.id])

  useEffect(() => {
    // 面板由 hidden 控制显示，重新可见时容器尺寸才可测量，需重新 fit 一次。
    if (visible) fitAddon.current?.fit()
  }, [visible])

  const start = async () => {
    const xterm = terminal.current
    if (!xterm || connection.current || phase === 'starting') return
    const request = ++generation.current
    const size = sized(
      fitAddon.current?.proposeDimensions() ?? { cols: xterm.cols, rows: xterm.rows },
    )
    setError('')
    setExitCode(undefined)
    setPhase('starting')
    xterm.reset()
    try {
      const { id } = await codingTerminalAPI.start(project.id, size)
      if (generation.current !== request) {
        // 启动期间组件已重建，回收这次请求创建的后端会话。
        void codingTerminalAPI.stop(project.id, id, true).catch(() => {})
        return
      }
      const item: Connection = {
        id,
        abort: new AbortController(),
        cursor: 0,
        ready: false,
        stopping: false,
        text: '',
        writing: false,
      }
      connection.current = item
      setPhase('running')
      xterm.focus()
      let retries = 0
      while (!item.abort.signal.aborted) {
        let attachedAt = 0
        try {
          await codingTerminalAPI.stream(
            project.id,
            id,
            item.cursor,
            item.abort.signal,
            () => {
              if (item.abort.signal.aborted) return
              attachedAt = performance.now()
              if (!item.stopping) {
                item.ready = true
                setPhase('running')
                void codingTerminalAPI.resize(project.id, item.id, sized(xterm)).catch(() => {})
              }
            },
            (event) => {
              if (item.abort.signal.aborted) return
              if (event.type === 'output') {
                // 游标用于断流重连时从上次位置续传，避免重复输出。
                item.cursor = event.cursor
                xterm.write(Uint8Array.from(atob(event.data), (char) => char.charCodeAt(0)))
                retries = 0
              } else if (event.type === 'reset') {
                // 后端缓冲区已失效（如超出保留窗口），清屏并提示历史被截断。
                item.cursor = event.cursor ?? 0
                xterm.reset()
                xterm.writeln('终端已恢复，超出缓冲区的历史输出已省略。')
              } else if (event.type === 'exit') {
                item.abort.abort()
                connection.current = null
                setExitCode(event.code)
                setPhase('exited')
              }
            },
          )
        } catch {
          if (item.abort.signal.aborted) break
        }
        if (item.abort.signal.aborted) break
        item.ready = false
        item.text = ''
        // 连接稳定超过 2 秒则视为正常断流，重置退避计数；否则连续失败会快速累计。
        if (attachedAt && performance.now() - attachedAt > 2000) retries = 0
        retries++
        if (retries > 4) {
          // 连续重连失败后放弃，结束后端会话避免无限重试。
          item.abort.abort()
          connection.current = null
          void codingTerminalAPI.stop(project.id, id, true).catch(() => {})
          setError('终端连接已中断，请重新启动')
          setPhase('exited')
          break
        }
        if (!item.stopping) setPhase('reconnecting')
        // 指数退避：300ms、600ms、1.2s… 降低后端压力。
        await pause(300 * 2 ** (retries - 1), item.abort.signal)
      }
    } catch (cause) {
      if (generation.current === request) {
        setError(errorMessage(cause))
        setPhase('idle')
      }
    }
  }

  const stop = async () => {
    const item = connection.current
    if (!item || phase === 'stopping') return
    item.stopping = true
    item.ready = false
    setError('')
    setPhase('stopping')
    try {
      await codingTerminalAPI.stop(project.id, item.id)
    } catch (cause) {
      if (connection.current !== item) return
      // 停止失败时恢复到可继续输入的状态，而不是让终端卡在 stopping。
      item.stopping = false
      item.ready = true
      setError(errorMessage(cause))
      setPhase('running')
    }
  }

  const busy = phase === 'running' || phase === 'reconnecting' || phase === 'stopping'
  return (
    <section className="coding-terminal" aria-label="项目终端" hidden={!visible}>
      <header className="coding-terminal-toolbar">
        <div className="coding-terminal-state" title={project.path}>
          <TerminalIcon size={15} />
          <span role="status">
            {STATUS[phase]}
            {exitCode !== undefined && ` · 退出码 ${exitCode}`}
          </span>
        </div>
        {busy ? (
          <button
            className="coding-button"
            type="button"
            onClick={() => void stop()}
            disabled={phase === 'stopping'}
          >
            <Square size={13} />
            停止
          </button>
        ) : (
          <button
            className="coding-button"
            type="button"
            onClick={() => void start()}
            disabled={phase === 'starting'}
          >
            <Play size={13} />
            {phase === 'exited' ? '重新打开' : '启动终端'}
          </button>
        )}
      </header>
      {error && (
        <p className="coding-alert" role="alert">
          {error}
        </p>
      )}
      <div className="coding-terminal-display" ref={host} />
    </section>
  )
}
