import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowUpRight,
  Check,
  FileArchive,
  LoaderCircle,
  Save,
  Sparkles,
  Upload,
  Users,
  X,
} from 'lucide-react'
import Live2DStage from '../components/Live2DStage'
import { notify, useStudio } from '../store/studio'
import { api } from '../api/client'
import type { Character } from '../types/api'

export default function CharactersPage() {
  const s = useStudio()
  const navigate = useNavigate()
  const [editing, setEditing] = useState<Character | null>(null)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const save = async () => {
    if (!editing) return
    setSaving(true)
    try {
      const character = await api.saveCharacter(editing)
      s.patch({ characters: s.characters.map((c) => (c.id === character.id ? character : c)) })
      setEditing(null)
      notify('角色人设已保存')
    } catch (e) {
      notify(String(e))
    } finally {
      setSaving(false)
    }
  }
  const importModel = async (f?: File) => {
    if (!f) return
    setImporting(true)
    try {
      const character = await api.importModel(f)
      s.patch({ characters: [...useStudio.getState().characters, character] })
      notify('模型已导入，可以开始设置人设了')
      setEditing(character)
    } catch (e) {
      notify(String(e))
    } finally {
      setImporting(false)
    }
  }
  return (
    <>
      <header className="page-header">
        <div>
          <span className="eyebrow">YOUR COMPANIONS</span>
          <h1>每个角色，都是独一无二的。</h1>
          <p>选择与你同频的伙伴，用人设赋予 TA 独特的灵魂。</p>
        </div>
        <button
          className="button primary"
          disabled={importing}
          onClick={() => file.current?.click()}
        >
          {importing ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}导入
          Live2D 模型
        </button>
        <input
          hidden
          ref={file}
          type="file"
          accept=".zip"
          onChange={(e) => {
            void importModel(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </header>
      <div className="characters-content">
        <div className="section-label">
          <span>
            <Users size={15} />
            我的角色
          </span>
          <span className="muted">{s.characters.length} 位伙伴</span>
        </div>
        <div className="character-grid">
          {s.characters.map((c) => (
            <article
              className={`character-card ${s.characterID === c.id ? 'selected' : ''}`}
              key={c.id}
            >
              <div
                className="character-preview"
                style={{
                  background: `radial-gradient(ellipse at 50% 70%, ${c.color}55, ${c.color}15)`,
                }}
              >
                <div className="preview-orbit" />
                <Live2DStage modelPath={c.model_path} miniature />
                {s.characterID === c.id && (
                  <span className="selected-badge">
                    <Check size={12} />
                    当前伙伴
                  </span>
                )}
                <span className="model-tag">LIVE2D</span>
              </div>
              <div className="character-card-body">
                <h2>
                  {c.name}
                  <span className="color-dot" style={{ background: c.color }} />
                </h2>
                <p>{c.description}</p>
                <div className="character-card-actions">
                  <button className="button ghost" onClick={() => setEditing({ ...c })}>
                    编辑人设
                  </button>
                  <button
                    className="button soft"
                    disabled={s.busy}
                    onClick={() => {
                      s.selectCharacter(c.id)
                      navigate('/')
                    }}
                  >
                    开始对话
                    <ArrowUpRight size={15} />
                  </button>
                </div>
              </div>
            </article>
          ))}
          <button
            className="import-card"
            disabled={importing}
            onClick={() => file.current?.click()}
          >
            <span>
              <FileArchive size={27} />
            </span>
            <strong>遇见一位新伙伴</strong>
            <p>
              导入 Cubism 模型 ZIP
              <br />
              添加你自己的 Live2D 角色
            </p>
            <small>支持 .model3.json · 最大 100MB</small>
          </button>
        </div>
        <div className="info-note">
          <Sparkles size={18} />
          <p>
            模型 ZIP 应包含一个 <code>.model3.json</code> 文件及其贴图、动作和物理文件。内置 Mao 与
            Shizuku 样本角色版权归 Live2D Inc. 所有。
          </p>
        </div>
      </div>
      {editing && (
        <div className="modal-backdrop">
          <div
            className="modal character-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="character-editor-title"
          >
            <button
              className="modal-close icon-button"
              aria-label="关闭"
              onClick={() => setEditing(null)}
            >
              <X size={18} />
            </button>
            <span className="eyebrow">CHARACTER SETTINGS</span>
            <h2 id="character-editor-title">赋予伙伴独特的个性</h2>
            <label className="form-field">
              角色名称
              <input
                maxLength={50}
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </label>
            <label className="form-field">
              一句话介绍
              <input
                maxLength={200}
                value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              />
            </label>
            <label className="form-field">
              角色人设 / System Prompt
              <textarea
                rows={8}
                maxLength={16000}
                value={editing.system_prompt}
                onChange={(e) => setEditing({ ...editing, system_prompt: e.target.value })}
              />
              <small>描述 TA 的身份、性格和说话方式。更新后将应用于下一次回复。</small>
            </label>
            <div className="modal-actions">
              <button className="button ghost" onClick={() => setEditing(null)}>
                取消
              </button>
              <button
                className="button primary"
                disabled={saving || !editing.name.trim()}
                onClick={() => void save()}
              >
                {saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}保存人设
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
