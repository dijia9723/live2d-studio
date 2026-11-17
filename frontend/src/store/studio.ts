/**
 * 文件职责：全局 Zustand 状态仓库。
 * 状态分区：角色/会话/消息、舞台外观（背景/特效/叠加/缩放）与运行时状态（busy/speaking）。
 * 通过 persist 只持久化用户偏好，其余数据每次启动从本地服务重新拉取。
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Character, Conversation, Message, SceneAsset, Settings } from '../types/api'
import type { StageEffectSetting } from '../types/stage'
import { api } from '../api/client'
import { draftKey, moveDraft } from './chatDrafts'

interface State {
  characters: Character[]
  conversations: Conversation[]
  messages: Message[]
  settings?: Settings
  characterID: string
  conversationID: string | null
  ready: boolean
  loadError: string
  busy: boolean
  speaking: boolean
  speechEnabled: boolean
  expression: string
  expressionRevision: number
  stage: string
  sceneAssets: SceneAsset[]
  backgroundAssetID: string | null
  backgroundFit: 'cover' | 'contain'
  backgroundDim: number
  videoPlaying: boolean
  effects: StageEffectSetting[]
  overlayAssetID: string | null
  overlayOpacity: number
  overlayBlendMode: 'normal' | 'screen' | 'lighten'
  zoom: number
  desktop: boolean
  notice: string
  chatError: string
  patch: (p: Partial<State>) => void
  setMood: (mood: string) => void
  initialize: () => Promise<void>
  refreshConversations: () => Promise<void>
  refreshSceneAssets: () => Promise<void>
  openConversation: (c: Conversation) => Promise<void>
  newConversation: (characterID?: string) => Promise<Conversation>
  selectCharacter: (id: string) => void
}
// 版本号用于丢弃过期的异步结果，避免快速切换会话/重复初始化时旧响应覆盖新状态。
let openVersion = 0
let initializeVersion = 0
const activeConversationKey = 'live2d-studio-active-conversation'

// 工作台窗口使用 sessionStorage 记住当前会话；桌宠窗口（?pet=1）不共享该记录。
function workbenchSession() {
  try {
    if (new URLSearchParams(window.location.search).get('pet') !== '1') return window.sessionStorage
  } catch {
    // 当前 WebView 可能禁用了存储。
  }
}

function rememberConversation(id: string | null) {
  const storage = workbenchSession()
  try {
    if (id) storage?.setItem(activeConversationKey, id)
    else storage?.removeItem(activeConversationKey)
  } catch {
    // 即使没有存储，也要保证当前窗口内的会话状态正常。
  }
}

// 启动时恢复上次打开的会话及其消息；失败时静默回退到新会话。
async function restoreConversation(conversations: Conversation[]) {
  try {
    const id = workbenchSession()?.getItem(activeConversationKey)
    const conversation = conversations.find((item) => item.id === id)
    if (conversation) return { conversation, messages: await api.messages(conversation.id) }
  } catch {
    // 读取历史失败不应阻止工作台启动。
  }
  rememberConversation(null)
  return { conversation: undefined, messages: [] as Message[] }
}

export const useStudio = create<State>()(
  persist(
    (set, get) => ({
      characters: [],
      conversations: [],
      messages: [],
      characterID: 'mao',
      conversationID: null,
      ready: false,
      loadError: '',
      busy: false,
      speaking: false,
      speechEnabled: true,
      expression: 'neutral',
      expressionRevision: 0,
      stage: 'lavender',
      sceneAssets: [],
      backgroundAssetID: null,
      backgroundFit: 'cover',
      backgroundDim: 0.08,
      videoPlaying: true,
      effects: [],
      overlayAssetID: null,
      overlayOpacity: 0.7,
      overlayBlendMode: 'screen',
      zoom: 1,
      desktop: false,
      notice: '',
      chatError: '',
      patch: set,
      // revision 自增用于通知舞台重新应用表情（相同表情也能触发一次过渡）。
      setMood: (expression) =>
        set((s) => ({ expression, expressionRevision: s.expressionRevision + 1 })),
      initialize: async () => {
        const version = ++initializeVersion
        try {
          // 素材接口缺失时降级为空列表，不阻塞整个启动流程。
          const [characters, conversations, settings, desktop, sceneAssets] = await Promise.all([
            api.characters(),
            api.conversations(),
            api.settings(),
            api.desktop(),
            api.sceneAssets().catch(() => [] as SceneAsset[]),
          ])
          if (version !== initializeVersion) return
          const restored = await restoreConversation(conversations)
          if (version !== initializeVersion) return
          const preferredCharacter = get().characterID
          set({
            characters,
            conversations,
            settings,
            sceneAssets,
            desktop: desktop.available,
            ready: true,
            loadError: '',
            conversationID: restored.conversation?.id ?? null,
            messages: restored.messages,
            // 优先沿用恢复会话的角色，否则回落到已保存的偏好角色（若仍存在）。
            characterID:
              restored.conversation?.character_id ??
              (characters.some((c) => c.id === preferredCharacter)
                ? preferredCharacter
                : characters[0]?.id),
          })
        } catch (e) {
          if (version === initializeVersion) set({ loadError: (e as Error).message })
        }
      },
      refreshConversations: async () => {
        set({ conversations: await api.conversations() })
      },
      refreshSceneAssets: async () => {
        set({ sceneAssets: await api.sceneAssets() })
      },
      openConversation: async (c) => {
        if (get().busy) return
        const version = ++openVersion
        const messages = await api.messages(c.id)
        // 生成中或已有更新的切换请求时，丢弃这次迟到结果。
        if (version === openVersion && !get().busy) {
          set({
            messages,
            conversationID: c.id,
            characterID: c.character_id,
            expression: 'neutral',
            expressionRevision: get().expressionRevision + 1,
            chatError: '',
          })
          rememberConversation(c.id)
        }
      },
      newConversation: async (id) => {
        ++openVersion
        const c = await api.createConversation(id || get().characterID)
        // 把“新会话草稿”迁移到真实会话 ID 下，避免已输入内容丢失。
        moveDraft(draftKey(null, c.character_id), c.id)
        set({
          conversationID: c.id,
          characterID: c.character_id,
          messages: [],
          chatError: '',
          conversations: [c, ...get().conversations],
        })
        rememberConversation(c.id)
        return c
      },
      selectCharacter: (id) => {
        if (get().busy) return
        ++openVersion
        set({
          characterID: id,
          conversationID: null,
          messages: [],
          expression: 'neutral',
          expressionRevision: get().expressionRevision + 1,
          chatError: '',
        })
        rememberConversation(null)
      },
    }),
    {
      name: 'live2d-studio-preferences',
      // 仅持久化用户偏好（角色与舞台外观），消息、会话、运行状态不写入磁盘。
      partialize: (s) => ({
        characterID: s.characterID,
        speechEnabled: s.speechEnabled,
        stage: s.stage,
        backgroundAssetID: s.backgroundAssetID,
        backgroundFit: s.backgroundFit,
        backgroundDim: s.backgroundDim,
        videoPlaying: s.videoPlaying,
        effects: s.effects,
        overlayAssetID: s.overlayAssetID,
        overlayOpacity: s.overlayOpacity,
        overlayBlendMode: s.overlayBlendMode,
        zoom: s.zoom,
      }),
    },
  ),
)
/** 显示一条全局 Toast 提示（自动由布局在数秒后清除）。 */
export function notify(message: string) {
  useStudio.setState({ notice: message })
}
