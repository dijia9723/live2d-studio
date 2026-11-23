/**
 * CodingTrustedExtension 展示插件声明的可信 Pi 扩展入口，
 * 并负责在桌面端展示风险说明、授权或撤销该版本的扩展授权。
 */
import { useEffect, useState } from 'react'
import { piPluginsAPI, type PiTrustedExtension } from '../../api/piplugins'

/**
 * CodingTrustedExtension 可信扩展授权面板。
 * 授权按插件版本生效，因此请求和提交都需要携带当前版本号。
 */
export default function CodingTrustedExtension({
  plugin,
  desktop,
}: {
  /** 插件 ID。 */
  plugin: string
  /** 是否运行在桌面客户端；浏览器中不允许授权原生扩展。 */
  desktop: boolean
}) {
  const [status, setStatus] = useState<PiTrustedExtension>()
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    piPluginsAPI
      .trustedExtension(plugin, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setStatus(value)
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message)
      })
    return () => controller.abort()
  }, [plugin])

  async function change(approved: boolean) {
    if (!status || busy) return
    setBusy(true)
    setError('')
    try {
      // 后端要求带上已确认的版本号，确保授权只对当前包内容生效。
      setStatus(await piPluginsAPI.grantExtension(plugin, status.version, approved))
      setConsent(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存可信扩展授权失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="pi-plugin-runtime-settings" aria-label="可信 Pi 扩展">
      <h3>可信 Pi 扩展</h3>
      {status && (
        <ol>
          {status.entries.map((entry) => (
            <li key={entry}>
              <code>{entry}</code>
            </li>
          ))}
        </ol>
      )}
      {status?.approved ? (
        <button
          type="button"
          className="pi-plugin-button"
          disabled={busy}
          onClick={() => void change(false)}
        >
          撤销可信授权
        </button>
      ) : status?.ready && desktop ? (
        <>
          <label>
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            我信任此版本及所列入口，允许扩展以当前用户权限运行原生 Node.js 代码。
          </label>
          <button
            type="button"
            className="pi-plugin-button"
            disabled={busy || !consent}
            onClick={() => void change(true)}
          >
            授权此版本
          </button>
        </>
      ) : (
        status && (
          <p>{desktop ? '请重新导入可校验的本地插件包。' : '在桌面客户端中确认并授权扩展。'}</p>
        )
      )}
      {error && (
        <p className="pi-plugins-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
