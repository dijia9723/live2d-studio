/**
 * 页面：角色库。
 * 支持导入模型、搜索过滤、查看卡片预览，并通过子组件完成角色编辑、记忆管理、动作命名与删除确认。
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
  Search,
  Tags,
  Trash2,
  Upload,
  Volume2,
} from 'lucide-react'
import CharacterActionNames from '../../components/character/CharacterActionNames'
import CharacterDeleteDialog from '../../components/character/CharacterDeleteDialog'
import CharacterEditor from '../../components/character/CharacterEditor'
import CharacterMemories from '../../components/character/CharacterMemories'
import CharacterPreview from '../../components/character/CharacterPreview'
import { notify, useStudio } from '../../store/studio'
import { api } from '../../api/client'
import { packageModelDirectory } from '../../utils/modelImport'
import { createCharacterPreviewRenderer } from '../../utils/characterPreviewRenderer'
import type { Character } from '../../types/api'

/** 编辑器 tab 标识，与 CharacterEditor 内部定义保持一致（外部只用作状态传递）。 */
type EditorTab = 'profile' | 'speech'

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
