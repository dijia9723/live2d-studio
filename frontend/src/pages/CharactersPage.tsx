/**
 * 页面：角色库。
 * 支持导入模型、编辑人设及动作命名、管理记忆与开始对话。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowUpRight,
  Brain,
  Check,
  FileArchive,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Save,
  Search,
  Tags,
  Trash2,
  Upload,
  Volume2,
  X,
} from 'lucide-react'
import CharacterPreview from '../components/CharacterPreview'
import CharacterMemories from '../components/CharacterMemories'
import CharacterActionNames from '../components/CharacterActionNames'
import CharacterSpeechFields from '../components/CharacterSpeechFields'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog'
import { notify, useStudio } from '../store/studio'
import { api } from '../api/client'
import { packageModelDirectory } from '../utils/modelImport'
import { createCharacterPreviewRenderer } from '../utils/characterPreviewRenderer'
import type { Character, CharacterSpeech } from '../types/api'

export default function CharactersPage() {
  const characters = useStudio((s) => s.characters)
  const characterID = useStudio((s) => s.characterID)
  const busy = useStudio((s) => s.busy)
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [editing, setEditing] = useState<{ character: Character; tab: EditorTab } | null>(null)
  const voiceCharacter = characters.find((character) => character.id === params.get('voice'))
  const editorCharacter = editing?.character ?? voiceCharacter
  const [memoryCharacter, setMemoryCharacter] = useState<Character | null>(null)
  const [namingCharacter, setNamingCharacter] = useState<Character | null>(null)
  const [removingCharacter, setRemovingCharacter] = useState<Character | null>(null)
  const [importing, setImporting] = useState(false)
  const [search, setSearch] = useState('')
  const [viewportIDs, setViewportIDs] = useState<ReadonlySet<string>>(() => new Set())
  const [previewRenderer] = useState(createCharacterPreviewRenderer)
  const grid = useRef<HTMLDivElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const folder = useRef<HTMLInputElement>(null)
  const query = search.trim().toLowerCase()
  const visibleCharacters = useMemo(
    () =>
      characters.filter((character) =>
        `${character.name}\n${character.description}`.toLowerCase().includes(query),
      ),
    [characters, query],
  )

  useEffect(() => {
    const previews = grid.current?.querySelectorAll<HTMLElement>('[data-character-preview]')
    if (!previews?.length) return
    const ids = new Set<string>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.characterPreview!
          if (entry.isIntersecting) ids.add(id)
          else ids.delete(id)
        }
        setViewportIDs(new Set(ids))
      },
      { root: grid.current?.closest('.workspace') ?? null },
    )
    previews.forEach((preview) => observer.observe(preview))
    return () => observer.disconnect()
  }, [visibleCharacters])

  const importModel = async (selection: File | File[]) => {
    setImporting(true)
    try {
      const model = Array.isArray(selection) ? await packageModelDirectory(selection) : selection
      if (!model.name.toLowerCase().endsWith('.zip')) {
        throw new Error('请选择模型 ZIP 文件')
      }
      const character = await api.importModel(model)
      const state = useStudio.getState()
      state.patch({ characters: [...state.characters, character] })
      setSearch('')
      setEditing({ character, tab: 'profile' })
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : '模型导入失败')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="characters-page">
      <header className="page-header characters-header">
        <div>
          <h1>角色库</h1>
          <p>选择聊天伙伴，管理人设、动作与表情名称和跨会话记忆。</p>
        </div>
        <div className="character-import-actions">
          <button
            className="button ghost character-import"
            disabled={importing}
            onClick={() => folder.current?.click()}
          >
            <FolderOpen size={17} />
            导入模型文件夹
          </button>
          <button
            className="button primary character-import"
            disabled={importing}
            onClick={() => file.current?.click()}
          >
            {importing ? <LoaderCircle className="spin" size={17} /> : <Upload size={17} />}
            {importing ? '正在导入…' : '导入 Live2D ZIP'}
          </button>
        </div>
        <input
          hidden
          ref={(input) => {
            folder.current = input
            input?.setAttribute('webkitdirectory', '')
          }}
          type="file"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            event.target.value = ''
            if (files.length) void importModel(files)
          }}
        />
        <input
          hidden
          ref={file}
          type="file"
          accept=".zip"
          onChange={(event) => {
            const model = event.target.files?.[0]
            event.target.value = ''
            if (model) void importModel(model)
          }}
        />
      </header>
      <section className="characters-content" aria-labelledby="character-list-title">
        <div className="characters-toolbar">
          <div className="characters-list-title">
            <h2 id="character-list-title">我的角色</h2>
            <span>
              {query ? `${visibleCharacters.length} / ` : ''}
              {characters.length} 位
            </span>
          </div>
          <label className="character-search">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label="搜索角色"
              placeholder="搜索角色"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>

        {visibleCharacters.length ? (
          <div className="character-grid" ref={grid}>
            {visibleCharacters.map((character) => {
              const selected = characterID === character.id
              // 动作弹窗使用独立的 WebGL 上下文，打开时暂停卡片预览。
              const previewing = !namingCharacter && viewportIDs.has(character.id)
              return (
                <article
                  className={`character-card${selected ? ' selected' : ''}`}
                  style={{ '--character-accent': character.color } as CSSProperties}
                  key={character.id}
                >
                  <div
                    className="character-preview"
                    data-character-preview={character.id}
                    role="group"
                    aria-label={`${character.name} 的模型`}
                  >
                    <div className="preview-orbit" aria-hidden="true" />
                    {previewing ? (
                      <CharacterPreview modelPath={character.model_path} renderer={previewRenderer} />
                    ) : (
                      <div className="character-preview-placeholder" aria-hidden="true">
                        <span className="character-preview-avatar">{Array.from(character.name)[0]}</span>
                      </div>
                    )}
                    {selected && (
                      <span className="selected-badge">
                        <Check size={14} />
                        当前伙伴
                      </span>
                    )}
                  </div>
                  <div className="character-card-body">
                    <h3>
                      <span className="color-dot" aria-hidden="true" />
                      {character.name}
                    </h3>
                    {character.description && <p>{character.description}</p>}
                    <div className="character-card-actions">
                      <button
                        className="button ghost"
                        onClick={() => setEditing({ character, tab: 'profile' })}
                      >
                        <Pencil size={15} />
                        角色配置
                      </button>
                      <button
                        className="button ghost"
                        aria-label={`编辑 ${character.name} 的角色语音`}
                        onClick={() => setEditing({ character, tab: 'speech' })}
                      >
                        <Volume2 size={15} />
                        角色语音
                      </button>
                      <button
                        className="button ghost"
                        aria-label={`自定义 ${character.name} 的动作与表情名称`}
                        onClick={() => setNamingCharacter(character)}
                      >
                        <Tags size={15} />
                        动作与表情
                      </button>
                      <button
                        className="button ghost"
                        aria-label={`管理 ${character.name} 的记忆`}
                        onClick={() => setMemoryCharacter(character)}
                      >
                        <Brain size={15} />
                        管理记忆
                      </button>
                      <button
                        className="button soft character-chat"
                        disabled={busy}
                        onClick={() => {
                          useStudio.getState().selectCharacter(character.id)
                          navigate('/')
                        }}
                      >
                        开始对话
                        <ArrowUpRight size={15} />
                      </button>
                      <button
                        className="button ghost"
                        aria-label={`删除 ${character.name}`}
                        onClick={() => setRemovingCharacter(character)}
                      >
                        <Trash2 size={15} />
                        删除
                      </button>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        ) : (
          <div className="characters-empty">
            <p>{query ? '未找到匹配的角色' : '角色库为空'}</p>
            <button
              className="button ghost"
              disabled={!query && importing}
              onClick={() => (query ? setSearch('') : file.current?.click())}
            >
              {query ? '清除搜索' : '导入 Live2D 模型'}
            </button>
          </div>
        )}

        <div className="character-import-note">
          <FileArchive size={17} aria-hidden="true" />
          <p>
            每次选择一个模型文件夹或 ZIP，支持新版 <code>.model3.json</code>{' '}
            与旧版 <code>.model.json</code> / <code>model.json</code>，以及只含 <code>.moc</code>
            的旧版模型；文件夹内含多个模型时自动选择 normal/普通形态导入。旧版模型播放需要另行配置
            Cubism 2 Core。内置 Mao 与 Shizuku 样本模型版权归 Live2D Inc. 所有。
          </p>
        </div>
      </section>
      {memoryCharacter && (
        <CharacterMemories
          key={memoryCharacter.id}
          character={memoryCharacter}
          onClose={() => setMemoryCharacter(null)}
        />
      )}
      {namingCharacter && (
        <CharacterActionNames
          key={namingCharacter.id}
          character={characters.find((item) => item.id === namingCharacter.id) ?? namingCharacter}
          onClose={() => setNamingCharacter(null)}
        />
      )}
      {editorCharacter && (
        <CharacterEditor
          key={editorCharacter.id}
          character={editorCharacter}
          initialTab={editing?.tab ?? 'speech'}
          onClose={() => {
            setEditing(null)
            if (voiceCharacter) {
              const next = new URLSearchParams(params)
              next.delete('voice')
              setParams(next, { replace: true })
            }
          }}
        />
      )}
      {removingCharacter && (
        <CharacterDeleteDialog
          character={removingCharacter}
          onClose={() => setRemovingCharacter(null)}
        />
      )}
    </div>
  )
}

/** 删除角色确认弹窗：确认后同时移除会话、记忆与导入的模型文件。 */
function CharacterDeleteDialog({
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

const editorTabs = [
  { id: 'profile', label: '基本信息' },
  { id: 'speech', label: '角色语音' },
] as const
type EditorTab = (typeof editorTabs)[number]['id']

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

/** 角色编辑弹窗：保存基本资料和朗读配置。 */
function CharacterEditor({
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
              <textarea
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
