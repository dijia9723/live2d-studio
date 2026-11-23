/**
 * CodingPluginRuntime 负责运行已授权的插件命令与视图：以 iframe srcDoc 隔离渲染插件面板，
 * 通过 postMessage 桥接插件调用后端 API，并提供插件设置编辑与工作面板停靠视图。
 */
import { useEffect, useRef, useState } from 'react'
import { Boxes, Play, Settings2 } from 'lucide-react'
import {
  piPluginsAPI,
  type PiHostPlugin,
  type PiHostSetting,
  type PiPluginWorkspace,
} from '../../api/piplugins'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import '../../assets/piplugins.css'

/** PluginFrame 当前打开的插件视图：html 由后端生成，key 变化时重建 iframe。 */
interface PluginFrame {
  key: string
  plugin: string
  html: string
  title: string
  workspace?: PiPluginWorkspace
}

/** failure 将未知异常转换为可展示的中文错误文案。 */
function failure(cause: unknown) {
  return cause instanceof Error ? cause.message : '插件操作失败'
}

/**
 * PluginView 以 sandbox iframe 渲染插件界面并处理其消息桥。
 * 仅接收来自该 iframe、origin 为 "null" 且 token 匹配的调用消息，
 * 并将每次调用转交后端校验权限。
 */
function PluginView({
  frame,
  onClose,
  onToast,
}: {
  frame: PluginFrame
  onClose: () => void
  onToast: (text: string) => void
}) {
  const element = useRef<HTMLIFrameElement>(null)
  // 每次挂载生成随机 token，防止同窗口下其他脚本伪造插件调用消息。
  const [token] = useState(() => crypto.randomUUID())
  // 用 ref 保存最新回调，避免 message 监听随 props 变化反复重建。
  const handlers = useRef({ onClose, onToast })
  handlers.current = { onClose, onToast }

  useEffect(() => {
    const localMethods = new Set(['ui.closePanel', 'ui.showToast'])
    let pending = 0
    let disposed = false
    const receive = async (event: MessageEvent) => {
      const source = element.current?.contentWindow
      // sandbox 未开放 allow-same-origin，iframe 的 origin 为 "null"，需按此校验来源。
      if (!source || event.source !== source || event.origin !== 'null') return
      const message = event.data
      if (
        !message ||
        message.type !== 'studio-plugin-invoke' ||
        message.token !== token ||
        !Number.isSafeInteger(message.id) ||
        typeof message.method !== 'string' ||
        message.method.length > 90 ||
        // 限制并发调用数量，防止插件用消息洪泛压垮桥接层。
        pending >= 8
      )
        return
      const reply = (fields: object) => {
        if (!disposed)
          source.postMessage({ type: 'studio-plugin-reply', token, id: message.id, ...fields }, '*')
      }
      pending++
      try {
        // 限制单条消息体积，避免插件向宿主传输超大载荷。
        if ((JSON.stringify(message.payload)?.length ?? 0) > 32_768) throw new Error('插件消息过大')
        if (localMethods.has(message.method)) {
          if (message.method === 'ui.closePanel') {
            reply({ ok: true })
            handlers.current.onClose()
            return
          }
          if (typeof message.payload === 'string') {
            handlers.current.onToast(message.payload.slice(0, 300))
            reply({ ok: true })
            return
          }
        }
        const result = await piPluginsAPI.bridge(
          frame.plugin,
          message.method,
          message.payload,
          frame.workspace,
        )
        for (const event of result.events ?? []) {
          if (event.type === 'toast' && event.text)
            handlers.current.onToast(event.text.slice(0, 300))
        }
        reply({ ok: true, value: result.value })
      } catch (cause) {
        reply({ ok: false, error: failure(cause) })
      } finally {
        pending--
      }
    }
    window.addEventListener('message', receive)
    return () => {
      disposed = true
      window.removeEventListener('message', receive)
    }
  }, [frame, token])

  return (
    // sandbox 只开放脚本而不开放同源，使插件无法直接读取 Studio 的 DOM/存储；
    // 文档加载完成后再下发 token，插件侧以此初始化消息桥。
    <iframe
      className="pi-plugin-runtime-frame"
      ref={element}
      srcDoc={frame.html}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      title={frame.title}
      onLoad={() =>
        element.current?.contentWindow?.postMessage({ type: 'studio-plugin-init', token }, '*')
      }
    />
  )
}

/** RuntimeSetting 渲染插件声明的一项设置（布尔、枚举、数字、密码或文本）。 */
function RuntimeSetting({
  setting,
  value,
  update,
}: {
  setting: PiHostSetting
  value: unknown
  update: (value: unknown) => void
}) {
  const current = value ?? setting.default
  return (
    <label>
      <strong>{setting.title || setting.key}</strong>
      {setting.description && <small>{setting.description}</small>}
      {setting.type === 'boolean' ? (
        <input
          type="checkbox"
          checked={current === true}
          onChange={(event) => update(event.target.checked)}
        />
      ) : setting.options?.length ? (
        <Select
          value={typeof current === 'string' && current ? current : '__none__'}
          onValueChange={(next) => update(next === '__none__' ? '' : next)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">请选择</SelectItem>
            {setting.options.map((option) => {
              const id = typeof option === 'string' ? option : option.value
              return (
                <SelectItem key={id} value={id}>
                  {typeof option === 'string' ? option : option.label || option.value}
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
      ) : (
        <input
          type={
            setting.type === 'number' ? 'number' : setting.type === 'secret' ? 'password' : 'text'
          }
          autoComplete="off"
          value={typeof current === 'string' || typeof current === 'number' ? current : ''}
          onChange={(event) =>
            update(
              setting.type === 'number' && event.target.value !== ''
                ? event.target.valueAsNumber
                : event.target.value,
            )
          }
        />
      )}
    </label>
  )
}

/** CodingPluginDock 工作面板中的插件视图停靠区，按插件视图 id 打开对应面板。 */
export function CodingPluginDock({
  plugins,
  workspace,
}: {
  /** 当前可用的宿主插件。 */
  plugins: PiHostPlugin[]
  /** 传给插件的项目/会话上下文。 */
  workspace?: PiPluginWorkspace
}) {
  const [frame, setFrame] = useState<PluginFrame>()
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <section className="pi-plugin-runtime-dock" aria-label="插件工作视图">
      <header className="coding-actions">
        {plugins.flatMap((plugin) =>
          (plugin.views ?? [])
            .filter((entry) => entry.kind === 'view')
            .map((entry) => (
              <button
                className="coding-button"
                type="button"
                key={`${plugin.id}/${entry.id}`}
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  setError('')
                  setNotice('')
                  try {
                    const next = await piPluginsAPI.pluginView(plugin.id, entry.id)
                    // key 使用随机值，确保每次打开都重建 iframe，不残留上次插件状态。
                    setFrame({ ...next, plugin: plugin.id, key: crypto.randomUUID(), workspace })
                  } catch (cause) {
                    setError(failure(cause))
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {entry.title}
              </button>
            )),
        )}
      </header>
      {error && (
        <p className="coding-alert" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="coding-muted" role="status">
          {notice}
        </p>
      )}
      {frame && (
        <PluginView
          key={frame.key}
          frame={frame}
          onClose={() => setFrame(undefined)}
          onToast={setNotice}
        />
      )}
    </section>
  )
}

/** CodingPluginRuntime 插件命令与面板对话框，可运行命令、打开视图并编辑插件设置。 */
export default function CodingPluginRuntime({
  plugins,
  initialPlugin,
  open,
  workspace,
  onOpenChange,
}: {
  /** 当前可用的宿主插件。 */
  plugins: PiHostPlugin[]
  /** 初始选中的插件 ID。 */
  initialPlugin?: string
  /** 对话框是否打开。 */
  open: boolean
  /** 传给插件的项目/会话上下文。 */
  workspace?: PiPluginWorkspace
  /** 对话框开关回调。 */
  onOpenChange: (open: boolean) => void
}) {
  const [selected, setSelected] = useState(initialPlugin || '')
  const [frame, setFrame] = useState<PluginFrame>()
  const [settings, setSettings] = useState<Record<string, unknown>>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const plugin = plugins.find((item) => item.id === selected) ?? plugins[0]
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      // 对话框卸载后异步命令仍可能返回，用标记避免对已卸载组件 setState。
      alive.current = false
    }
  }, [])

  async function view(id: string) {
    if (!plugin) return
    const next = await piPluginsAPI.pluginView(plugin.id, id)
    if (alive.current)
      setFrame({ ...next, plugin: plugin.id, key: id + ':' + crypto.randomUUID(), workspace })
  }

  async function command(id: string) {
    if (!plugin) return
    const response = await piPluginsAPI.command(plugin.id, id, workspace)
    if (!alive.current) return
    for (const event of response.events ?? []) {
      if (event.type === 'toast' && event.text) setNotice(event.text.slice(0, 300))
      // 命令可以要求宿主打开某个面板视图，按事件指定的视图 id 加载。
      if (event.type === 'panel') await view(event.id || 'panel')
    }
    if (response.result !== undefined && !response.events?.length) {
      const result =
        typeof response.result === 'string' ? response.result : JSON.stringify(response.result)
      setNotice(result.slice(0, 1200))
    }
  }

  async function perform(action: () => Promise<void>) {
    // 同一时间只允许一个插件操作，避免设置保存与视图加载交叉覆盖状态。
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (cause) {
      if (alive.current) setError(failure(cause))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="pi-plugin-dialog pi-plugin-runtime">
        <DialogTitle>
          <Boxes size={17} />
          插件命令与面板
        </DialogTitle>
        <DialogDescription>运行已获授权的插件命令和视图。</DialogDescription>
        {plugin && (
          <label className="pi-plugin-version-select">
            插件
            <Select
              value={plugin.id}
              disabled={busy}
              onValueChange={(id) => {
                setSelected(id)
                setSettings(undefined)
                setFrame(undefined)
                setNotice('')
                setError('')
              }}
            >
              <SelectTrigger aria-label="选择插件">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {plugins.map((entry) => (
                  <SelectItem value={entry.id} key={entry.id}>
                    {entry.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        )}
        <div className="pi-plugin-card-actions">
          {plugin?.commands?.map((item) => (
            <button
              type="button"
              className="pi-plugin-button"
              disabled={busy}
              key={item.id}
              onClick={() => void perform(() => command(item.id))}
            >
              <Play size={13} />
              {item.title}
            </button>
          ))}
          {plugin?.views?.map((item) => (
            <button
              type="button"
              className="pi-plugin-button"
              disabled={busy}
              key={item.id}
              onClick={() => void perform(() => view(item.id))}
            >
              {item.title}
            </button>
          ))}
          {!!plugin?.settings?.length && (
            <button
              type="button"
              className="pi-plugin-button"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const next = await piPluginsAPI.settings(plugin.id)
                  if (alive.current) setSettings(next)
                })
              }
            >
              <Settings2 size={14} />
              插件设置
            </button>
          )}
        </div>
        {error && (
          <p className="pi-plugins-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="pi-plugins-notice" role="status">
            {notice}
          </p>
        )}
        {!plugin && <p>在插件中心启用插件并授予运行权限后，可从这里打开。</p>}
        {settings && plugin && (
          <form
            className="pi-plugin-runtime-settings"
            onSubmit={(event) => {
              event.preventDefault()
              void perform(async () => {
                const next = await piPluginsAPI.saveSettings(plugin.id, settings)
                if (alive.current) {
                  setSettings(next)
                  setNotice('插件设置已保存')
                }
              })
            }}
          >
            {plugin.settings?.map((setting) => (
              <RuntimeSetting
                key={setting.key}
                setting={setting}
                value={settings[setting.key]}
                update={(value) => setSettings((current) => ({ ...current, [setting.key]: value }))}
              />
            ))}
            <button className="pi-plugin-button" data-primary="true" disabled={busy}>
              保存插件设置
            </button>
          </form>
        )}
        {open && frame && (
          <PluginView
            key={frame.key}
            frame={frame}
            onClose={() => setFrame(undefined)}
            onToast={setNotice}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
