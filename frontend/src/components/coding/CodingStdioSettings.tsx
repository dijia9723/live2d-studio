import { useEffect, useState } from 'react'
import { piPluginsAPI, type PiStdioServer } from '../../api/piplugins'

function formatError(cause: unknown) {
  return cause instanceof Error ? cause.message : '无法保存 MCP 设置'
}

export default function CodingStdioSettings({
  plugin,
  desktop,
}: {
  plugin: string
  desktop: boolean
}) {
  const [servers, setServers] = useState<PiStdioServer[]>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<Record<string, Record<string, string>>>({})

  useEffect(() => {
    const controller = new AbortController()
    piPluginsAPI
      .stdio(plugin, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setServers(result)
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(formatError(cause))
      })
    return () => controller.abort()
  }, [plugin])

  async function save(server: PiStdioServer, approved: boolean) {
    setBusy(true)
    setError('')
    try {
      await piPluginsAPI.setStdio(plugin, server.id, approved, draft[server.id])
      setDraft((current) => ({ ...current, [server.id]: {} }))
      setServers(await piPluginsAPI.stdio(plugin))
    } catch (cause) {
      setError(formatError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="pi-plugin-runtime-settings" aria-label="本地 MCP">
      <h3>本地 MCP</h3>
      {error && (
        <p className="pi-plugins-error" role="alert">
          {error}
        </p>
      )}
      {!servers && !error && <p role="status">正在读取服务清单…</p>}
      {!desktop && <p>在桌面客户端中确认并授权启动命令。</p>}
      {servers?.map((server) => (
        <div className="pi-plugin-runtime-setting" key={server.id}>
          <strong>{server.label || server.id}</strong>
          <code>{JSON.stringify([server.command, ...(server.args ?? [])])}</code>
          {!server.ready && <p>当前系统找不到命令，请先安装对应运行环境。</p>}
          {server.environment.length > 0 && <p>声明的环境变量：{server.environment.join('、')}</p>}
          {server.settings.map((key) => (
            <label key={key}>
              {key}
              <input
                type="password"
                autoComplete="off"
                value={draft[server.id]?.[key] ?? ''}
                placeholder={server.approved ? '留空保留当前值' : undefined}
                disabled={!desktop || busy}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    [server.id]: { ...current[server.id], [key]: event.target.value },
                  }))
                }
              />
            </label>
          ))}
          <div className="pi-plugin-card-actions">
            <button
              type="button"
              className="pi-plugin-button"
              data-primary="true"
              disabled={!desktop || busy}
              onClick={() => void save(server, true)}
            >
              {server.approved ? '更新授权' : '授权启动此命令'}
            </button>
            {server.approved && (
              <button
                type="button"
                className="pi-plugin-button"
                disabled={busy}
                onClick={() => void save(server, false)}
              >
                撤销授权
              </button>
            )}
          </div>
        </div>
      ))}
    </section>
  )
}
