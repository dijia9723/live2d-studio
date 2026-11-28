/**
 * 页面：角色库。
 * 支持导入模型、搜索过滤、查看卡片预览，并通过子组件完成角色编辑、记忆管理、动作命名与删除确认。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowUpRight,
  Check,
  FileArchive,
  FolderOpen,
  LoaderCircle,
  Search,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react'
import CharacterDeleteDialog from '../../components/character/CharacterDeleteDialog'
import CharacterPreview from '../../components/character/CharacterPreview'
import { notify, useStudio } from '../../store/studio'
import { api } from '../../api/client'
import { packageModelDirectory } from '../../utils/modelImport'
import { createCharacterPreviewRenderer } from '../../utils/characterPreviewRenderer'
import type { Character } from '../../types/api'

export default function CharactersPage() {
  const characters = useStudio((s) => s.characters)
  const characterID = useStudio((s) => s.characterID)
  const busy = useStudio((s) => s.busy)
  const navigate = useNavigate()
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
      navigate(`/characters/${character.id}/edit`)
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
          <p>选择聊天伙伴，在模型工作台统一管理人设、语音、动作表情与跨会话记忆。</p>
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
              const previewing = viewportIDs.has(character.id)
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
                        aria-label={`打开 ${character.name} 的模型工作台`}
                        onClick={() => navigate(`/characters/${character.id}/edit`)}
                      >
                        <Wand2 size={15} />
                        模型工作台
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
      {removingCharacter && (
        <CharacterDeleteDialog
          character={removingCharacter}
          onClose={() => setRemovingCharacter(null)}
        />
      )}
    </div>
  )
}
