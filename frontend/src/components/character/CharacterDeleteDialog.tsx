/**
 * 文件职责：删除角色确认弹窗。
 * 确认后同时移除会话、记忆与导入的模型文件，并在删除当前角色时回落到列表首位。
 */
import { useState } from 'react'
import { LoaderCircle, Trash2, X } from 'lucide-react'
import { api } from '../../api/client'
import { notify, useStudio } from '../../store/studio'
import type { Character } from '../../types/api'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'

/**
 * @param character 待删除的角色
 * @param onClose 关闭弹窗回调
 */
export default function CharacterDeleteDialog({
  character,
  onClose,
}: {
  character: Character
  onClose: () => void
}) {
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState('')

  const close = () => {
    if (removing) return
    onClose()
  }

  const remove = async () => {
    if (removing) return
    setRemoving(true)
    setError('')
    try {
      await api.deleteCharacter(character.id)
      const state = useStudio.getState()
      const characters = state.characters.filter((item) => item.id !== character.id)
      const conversations = state.conversations.filter(
        (item) => item.character_id !== character.id,
      )
      // 删除当前角色时回落到列表首位；删除当前会话所属角色时清空会话。
      const patch: Parameters<typeof state.patch>[0] = { characters, conversations }
      if (state.characterID === character.id) {
        patch.characterID = characters[0]?.id ?? ''
        patch.conversationID = null
        patch.messages = []
      } else if (
        state.conversationID &&
        !conversations.some((item) => item.id === state.conversationID)
      ) {
        patch.conversationID = null
        patch.messages = []
      }
      state.patch(patch)
      onClose()
      notify(`已删除角色 ${character.name}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除角色失败')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        className="modal character-dialog character-delete-dialog"
        showCloseButton={false}
        aria-labelledby="character-delete-title"
        onEscapeKeyDown={(event) => {
          if (removing) event.preventDefault()
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <header className="character-dialog-heading">
          <span className="character-dialog-icon">
            <Trash2 size={19} />
          </span>
          <div>
            <DialogTitle asChild>
              <h2 id="character-delete-title">删除 {character.name}？</h2>
            </DialogTitle>
            <p>角色的会话记录、记忆与导入的模型文件会一并删除，且无法恢复。</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭删除确认"
            disabled={removing}
            onClick={close}
          >
            <X size={20} />
          </button>
        </header>
        <div className="character-delete-body">
          {error && (
            <p className="character-form-error" role="alert">
              {error}
            </p>
          )}
          <footer className="modal-actions">
            <button type="button" className="button ghost" disabled={removing} onClick={close}>
              取消
            </button>
            <button
              type="button"
              className="button danger"
              disabled={removing}
              onClick={() => void remove()}
            >
              {removing ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
              删除角色
            </button>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  )
}
