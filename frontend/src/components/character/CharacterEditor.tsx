/**
 * 文件职责：角色编辑弹窗。
 * 支持编辑基本资料（名称、介绍、系统提示词）和朗读配置，按 tab 切换。
 * tab 类型和 sameSpeech 工具函数为模块内部实现细节，随组件一起组织。
 */
import { useState } from 'react'
import { LoaderCircle, Pencil, Save, X } from 'lucide-react'
import { api } from '../../api/client'
import { notify, useStudio } from '../../store/studio'
import CharacterSpeechFields from './CharacterSpeechFields'
import type { Character, CharacterSpeech } from '../../types/api'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { Textarea } from '../ui/textarea'

const editorTabs = [
  { id: 'profile', label: '基本信息' },
  { id: 'speech', label: '角色语音' },
] as const
type EditorTab = (typeof editorTabs)[number]['id']

/** 比较两个语音配置是否等价；inherit 视为与另一配置的 mode 无关的值相等。 */
function sameSpeech(left?: CharacterSpeech, right?: CharacterSpeech) {
  if ((left?.mode ?? 'inherit') !== (right?.mode ?? 'inherit')) return false
  if (left?.mode === 'local' && right?.mode === 'local') {
    return (
      left.local_tts?.model === right.local_tts?.model &&
      left.local_tts?.speaker === right.local_tts?.speaker &&
      left.local_tts?.speed === right.local_tts?.speed
    )
  }
  const leftVoice = left && 'voice' in left ? left.voice : undefined
  const rightVoice = right && 'voice' in right ? right.voice : undefined
  return (leftVoice ?? '') === (rightVoice ?? '')
}

/**
 * @param character 正在编辑的角色
 * @param initialTab 初始激活的 tab
 * @param onClose 关闭弹窗回调
 */
export default function CharacterEditor({
  character,
  initialTab,
  onClose,
}: {
  character: Character
  initialTab: EditorTab
  onClose: () => void
}) {
  const [editing, setEditing] = useState(character)
  const [tab, setTab] = useState(initialTab)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const name = editing.name.trim()
  const encoder = new TextEncoder()
  const nameBytes = encoder.encode(name).length
  const promptBytes = encoder.encode(editing.system_prompt).length
  const profileValid = nameBytes > 0 && nameBytes <= 100 && promptBytes <= 24000
  const speechValid = editing.speech?.mode !== 'local' || !!editing.speech.local_tts
  const valid = profileValid && speechValid
  const speech = editing.speech
  const speechChanged = !sameSpeech(speech, character.speech)
  const dirty =
    speechChanged ||
    name !== character.name ||
    editing.description !== character.description ||
    editing.system_prompt !== character.system_prompt

  const close = () => {
    if (saving) return
    onClose()
  }

  const save = async () => {
    if (!valid || saving || !dirty) return
    setSaving(true)
    setError('')
    try {
      const saved = await api.saveCharacter({
        ...editing,
        name,
        speech: speechChanged ? speech : undefined,
      })
      const state = useStudio.getState()
      state.patch({
        characters: state.characters.map((item) => (item.id === saved.id ? saved : item)),
      })
      onClose()
      notify('角色配置已保存')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存角色配置失败')
    } finally {
      setSaving(false)
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
        className={`modal character-dialog character-editor${tab === 'speech' && speech?.mode === 'local' ? ' character-editor-wide' : ''}`}
        showCloseButton={false}
        aria-labelledby="character-editor-title"
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault()
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <header className="character-dialog-heading">
          <span className="character-dialog-icon">
            <Pencil size={19} />
          </span>
          <div>
            <DialogTitle asChild>
              <h2 id="character-editor-title">{character.name} 的角色配置</h2>
            </DialogTitle>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭角色配置"
            disabled={saving}
            onClick={close}
          >
            <X size={20} />
          </button>
        </header>
        <form
          className="character-editor-form"
          aria-busy={saving}
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div
            className="character-editor-tabs"
            role="tablist"
            aria-label="角色配置分类"
            onKeyDown={(event) => {
              const alternate = tab === 'profile' ? 'speech' : 'profile'
              const next =
                event.key === 'Home' ? 'profile' : event.key === 'End' ? 'speech' : alternate
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              setTab(next)
              event.currentTarget
                .querySelector<HTMLButtonElement>(`#character-editor-tab-${next}`)
                ?.focus()
            }}
          >
            {editorTabs.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`character-editor-tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`character-editor-panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                disabled={saving}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id="character-editor-panel-profile"
            aria-labelledby="character-editor-tab-profile"
            hidden={tab !== 'profile'}
          >
            <label className="form-field">
              角色名称
              <input
                maxLength={100}
                disabled={saving}
                value={editing.name}
                aria-invalid={nameBytes > 100}
                aria-describedby={nameBytes > 100 ? 'character-name-length' : undefined}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
              />
              {nameBytes > 100 && (
                <small className="character-field-error" id="character-name-length">
                  名称最多 100 字节，请缩短输入。
                </small>
              )}
            </label>
            <label className="form-field">
              角色介绍
              <input
                maxLength={200}
                disabled={saving}
                value={editing.description}
                onChange={(event) => setEditing({ ...editing, description: event.target.value })}
              />
            </label>
            <label className="form-field">
              系统提示词
              <Textarea
                rows={7}
                maxLength={24000}
                disabled={saving}
                value={editing.system_prompt}
                aria-invalid={promptBytes > 24000}
                aria-describedby="character-prompt-help"
                onChange={(event) => setEditing({ ...editing, system_prompt: event.target.value })}
              />
              <small
                className={promptBytes > 24000 ? 'character-field-error' : undefined}
                id="character-prompt-help"
              >
                {promptBytes > 24000
                  ? '提示词最多 24,000 字节，请缩短输入。'
                  : '描述角色的身份、性格和说话方式。'}
              </small>
            </label>
          </div>
          <div
            role="tabpanel"
            id="character-editor-panel-speech"
            aria-labelledby="character-editor-tab-speech"
            hidden={tab !== 'speech'}
          >
            <CharacterSpeechFields
              value={speech}
              active={tab === 'speech'}
              disabled={saving}
              onChange={(speech) => setEditing((current) => ({ ...current, speech }))}
            />
          </div>
          {tab === 'profile' && !speechValid && (
            <p className="character-form-error">请在「角色语音」中选择本地模型。</p>
          )}
          {tab === 'speech' && !profileValid && (
            <p className="character-form-error">请检查「基本信息」中的名称和系统提示词。</p>
          )}
          {error && (
            <p className="character-form-error" role="alert">
              {error}
            </p>
          )}
          <footer className="modal-actions">
            <span className="character-editor-save-state" role="status">
              {saving ? '正在保存…' : dirty ? '有未保存的修改' : ''}
            </span>
            <button type="button" className="button ghost" disabled={saving} onClick={close}>
              取消
            </button>
            <button type="submit" className="button primary" disabled={saving || !valid || !dirty}>
              {saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
              保存角色配置
            </button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  )
}
