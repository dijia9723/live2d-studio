/**
 * 页面：角色库。
 * 支持导入 Live2D 模型 ZIP、搜索角色、预览模型、进入模型编辑子页面、管理记忆与开始对话。
 */
import { useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowUpRight,
  Brain,
  Check,
  FileArchive,
  LoaderCircle,
  Pencil,
  Play,
  Search,
  Upload,
} from 'lucide-react'
import Live2DStage from '../components/Live2DStage'
import CharacterMemories from '../components/CharacterMemories'
import { notify, useStudio } from '../store/studio'
import { api } from '../api/client'
import type { Character } from '../types/api'

export default function CharactersPage() {
  const characters = useStudio((s) => s.characters)
  const characterID = useStudio((s) => s.characterID)
  const busy = useStudio((s) => s.busy)
  const navigate = useNavigate()
  const [memoryCharacter, setMemoryCharacter] = useState<Character | null>(null)
  const [importing, setImporting] = useState(false)
  const [search, setSearch] = useState('')
  const [previewChoice, setPreviewChoice] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const query = search.trim().toLowerCase()
  const visibleCharacters = characters.filter((character) =>
    `${character.name}\n${character.description}`.toLowerCase().includes(query),
  )
  // Cubism 的着色器状态在模型之间共享，同一时刻只能有一个预览占用 WebGL 上下文。
  const previewID =
    visibleCharacters.find((character) => character.id === previewChoice)?.id ??
    visibleCharacters.find((character) => character.id === characterID)?.id ??
    visibleCharacters[0]?.id

  // 导入模型 ZIP：限制 100MB，成功后追加角色并跳转到模型编辑子页面。
  const importModel = async (model: File) => {
    if (!model.name.toLowerCase().endsWith('.zip') || model.size > 100 * 1024 ** 2) {
      notify('请选择不超过 100MB 的模型 ZIP 文件')
      return
    }
    setImporting(true)
    try {
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
          <p>选择聊天伙伴，管理角色人设和跨会话记忆。</p>
        </div>
        <button
          className="button primary character-import"
          disabled={importing}
          onClick={() => file.current?.click()}
        >
          {importing ? <LoaderCircle className="spin" size={17} /> : <Upload size={17} />}
          {importing ? '正在导入…' : '导入 Live2D 模型'}
        </button>
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
          <div className="character-grid">
            {visibleCharacters.map((character) => {
              const selected = characterID === character.id
              const previewing = previewID === character.id
              return (
                <article
                  className={`character-card${selected ? ' selected' : ''}`}
                  style={{ '--character-accent': character.color } as CSSProperties}
                  key={character.id}
                >
                  <div
                    className="character-preview"
                    role="group"
                    aria-label={`${character.name} 的模型`}
                    tabIndex={-1}
                  >
                    <div className="preview-orbit" aria-hidden="true" />
                    {previewing ? (
                      <>
                        <Live2DStage modelPath={character.model_path} miniature />
                        <span className="character-preview-state">实时预览</span>
                      </>
                    ) : (
                      <button
                        className="character-preview-trigger"
                        aria-label={`预览 ${character.name} 模型`}
                        onClick={(event) => {
                          event.currentTarget.parentElement?.focus({ preventScroll: true })
                          setPreviewChoice(character.id)
                        }}
                      >
                        <span className="character-preview-avatar" aria-hidden="true">
                          {Array.from(character.name)[0]}
                        </span>
                        <span className="character-preview-action">
                          <Play size={14} />
                          预览模型
                        </span>
                      </button>
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
                        onClick={() => navigate(`/characters/${character.id}/edit`)}
                      >
                        <Pencil size={15} />
                        编辑模型
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
            导入支持不超过 100MB 的 ZIP，需包含 <code>.model3.json</code> 及其引用的模型资源。内置
            Mao 与 Shizuku 样本模型版权归 Live2D Inc. 所有。
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
    </div>
  )
}
