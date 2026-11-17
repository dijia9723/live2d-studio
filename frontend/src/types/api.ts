export interface Character {
  id: string
  name: string
  description: string
  model_path: string
  system_prompt: string
  color: string
  created_at: string
}
export interface Conversation {
  id: string
  character_id: string
  title: string
  created_at: string
  updated_at: string
}
export interface Message {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  image?: string
  error?: string
  status: 'complete' | 'failed' | 'interrupted' | 'streaming'
  created_at: string
}
export interface Settings {
  llm: {
    base_url: string
    api_key: string
    model: string
    temperature: number
    max_tokens: number
    context_messages: number
    tools_enabled: boolean
  }
  speech: {
    mode: 'browser' | 'api' | 'off'
    base_url: string
    api_key: string
    asr_model: string
    tts_model: string
    voice: string
    language: string
  }
  has_llm_key: boolean
  has_speech_key: boolean
  environment_overrides: string[]
}
export interface StreamEvent {
  type: 'user' | 'delta' | 'expression' | 'done' | 'error'
  text?: string
  expression?: string
  message?: Message
}
export interface SceneAsset {
  id: string
  name: string
  kind: 'image' | 'video'
  mime_type: string
  size: number
  url: string
  created_at: string
}
