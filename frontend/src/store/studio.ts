import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Character, Conversation, Message, SceneAsset, Settings } from '../types/api'
import type { StageEffectSetting } from '../types/stage'
import { api } from '../api/client'

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
let openVersion = 0
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
      setMood: (expression) =>
        set((s) => ({ expression, expressionRevision: s.expressionRevision + 1 })),
      initialize: async () => {
        try {
          const [characters, conversations, settings, desktop, sceneAssets] = await Promise.all([
            api.characters(),
            api.conversations(),
            api.settings(),
            api.desktop(),
            api.sceneAssets().catch(() => [] as SceneAsset[]),
          ])
          set({
            characters,
            conversations,
            settings,
            sceneAssets,
            desktop: desktop.available,
            ready: true,
            loadError: '',
            characterID: characters.some((c) => c.id === get().characterID)
              ? get().characterID
              : characters[0]?.id,
          })
        } catch (e) {
          set({ loadError: (e as Error).message })
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
        if (version === openVersion)
          set({
            messages,
            conversationID: c.id,
            characterID: c.character_id,
            expression: 'neutral',
            expressionRevision: get().expressionRevision + 1,
            chatError: '',
          })
      },
      newConversation: async (id) => {
        ++openVersion
        const c = await api.createConversation(id || get().characterID)
        set({
          conversationID: c.id,
          characterID: c.character_id,
          messages: [],
          chatError: '',
          conversations: [c, ...get().conversations],
        })
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
      },
    }),
    {
      name: 'live2d-studio-preferences',
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
export function notify(message: string) {
  useStudio.setState({ notice: message })
}
