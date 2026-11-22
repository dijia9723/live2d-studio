import { useEffect, useRef, useState } from 'react'
import { Boxes, Play, Settings2 } from 'lucide-react'
import {
  piPluginsAPI,
  type PiHostPlugin,
  type PiHostSetting,
  type PiPluginWorkspace,
} from '../api/piplugins'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import '../assets/piplugins.css'

interface PluginFrame {
  key: string
  plugin: string
  html: string
  title: string
  workspace?: PiPluginWorkspace
}

function failure(cause: unknown) {
  return cause instanceof Error ? cause.message : '插件操作失败'
}

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
  const [token] = useState(() => crypto.randomUUID())
  const handlers = useRef({ onClose, onToast })
  handlers.current = { onClose, onToast }

  useEffect(() => {
    const localMethods = new Set(['ui.closePanel', 'ui.showToast'])
    let pending = 0
    let disposed = false
    const receive = async (event: MessageEvent) => {
      const source = element.current?.contentWindow
      if (!source || event.source !== source || event.origin !== 'null') return
      const message = event.data
      if (
        !message ||
        message.type !== 'studio-plugin-invoke' ||
        message.token !== token ||
        !Number.isSafeInteger(message.id) ||
        typeof message.method !== 'string' ||
        message.method.length > 90 ||
        pending >= 8
      )
        return
      const reply = (fields: object) => {
        if (!disposed)
          source.postMessage({ type: 'studio-plugin-reply', token, id: message.id, ...fields }, '*')
      }
      pending++
      try {
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
        <select
          value={typeof current === 'string' ? current : ''}
          onChange={(event) => update(event.target.value)}
        >
          <option value="">请选择</option>
          {setting.options.map((option) => {
            const id = typeof option === 'string' ? option : option.value
            return (
              <option key={id} value={id}>
                {typeof option === 'string' ? option : option.label || option.value}
              </option>
            )
          })}
        </select>
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

export function CodingPluginDock({
  plugins,
  workspace,
}: {
  plugins: PiHostPlugin[]
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

export default function CodingPluginRuntime({
  plugins,
  initialPlugin,
  open,
  workspace,
  onOpenChange,
}: {
  plugins: PiHostPlugin[]
  initialPlugin?: string
  open: boolean
  workspace?: PiPluginWorkspace
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
      if (event.type === 'panel') await view(event.id || 'panel')
    }
    if (response.result !== undefined && !response.events?.length) {
      const result =
        typeof response.result === 'string' ? response.result : JSON.stringify(response.result)
      setNotice(result.slice(0, 1200))
    }
  }

  async function perform(action: () => Promise<void>) {
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
            <select
              aria-label="选择插件"
              value={plugin.id}
              disabled={busy}
              onChange={(event) => {
                setSelected(event.target.value)
                setSettings(undefined)
                setFrame(undefined)
                setNotice('')
                setError('')
              }}
            >
              {plugins.map((entry) => (
                <option value={entry.id} key={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
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
