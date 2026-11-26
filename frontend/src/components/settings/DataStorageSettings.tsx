import { useEffect, useState } from 'react'
import { FolderOpen, HardDrive, Info, LoaderCircle } from 'lucide-react'
import { api } from '../../api/client'
import type { StorageSettings } from '../../types/api'

export default function DataStorageSettings() {
  const [storage, setStorage] = useState<StorageSettings>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [choosing, setChoosing] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    api
      .storageSettings(controller.signal)
      .then(setStorage)
      .catch((err: Error) => {
        if (!controller.signal.aborted) setError(err.message)
      })
    return () => controller.abort()
  }, [attempt])

  const choose = async () => {
    setError('')
    setChoosing(true)
    try {
      setStorage(await api.chooseDataDirectory())
    } catch (err) {
      setError(err instanceof Error ? err.message : '更改数据目录失败')
    } finally {
      setChoosing(false)
    }
  }

  const pending = storage && storage.current_directory !== storage.next_directory

  return (
    <section className="settings-card">
      <div className="card-heading">
        <span className="card-icon">
          <HardDrive size={21} aria-hidden="true" />
        </span>
        <div>
          <h2>数据存储目录</h2>
          <p>角色、对话、记忆、模型和场景素材存放在此目录。</p>
        </div>
      </div>
      {storage && (
        <>
          <dl className="settings-storage-paths">
            <dt>当前目录</dt>
            <dd>{storage.current_directory}</dd>
            {pending && (
              <>
                <dt>下次启动使用的目录</dt>
                <dd role="status">{storage.next_directory}</dd>
              </>
            )}
          </dl>
          <div className="settings-note">
            <Info size={18} aria-hidden="true" />
            <p>
              {storage.environment_override
                ? '当前目录由 STUDIO_DATA_DIR 环境变量指定。'
                : storage.can_choose
                  ? '选择后重启应用生效。已有数据留在原目录，选回原目录可继续使用。'
                  : '请在桌面客户端使用目录选择器。'}
            </p>
          </div>
          {storage.can_choose && (
            <button
              type="button"
              className="button soft"
              disabled={choosing}
              onClick={() => void choose()}
            >
              {choosing ? <LoaderCircle size={16} className="spin" /> : <FolderOpen size={16} />}
              {choosing ? '正在选择目录…' : '选择目录'}
            </button>
          )}
        </>
      )}
      {error && (
        <p className="settings-alert settings-storage-error" role="alert">
          {error}
        </p>
      )}
      {!storage &&
        (error ? (
          <button
            type="button"
            className="button soft"
            onClick={() => {
              setError('')
              setAttempt((value) => value + 1)
            }}
          >
            重新读取
          </button>
        ) : (
          <p className="settings-save-state" role="status">
            正在读取存储设置…
          </p>
        ))}
    </section>
  )
}
