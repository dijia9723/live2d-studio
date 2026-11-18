/**
 * 文件职责：后端 API 的数据结构类型定义（角色、会话、消息、设置、流式事件、场景素材）。
 */

/** 角色（聊天伙伴），model_path 指向 Live2D 模型的 model3.json。 */
export interface Character {
  id: string
  name: string
  description: string
  model_path: string
  system_prompt: string
  action_names?: ActionNames
  color: string
  created_at: string
}

/** 命名按稳定资源 ID 保存；空名称使用默认名称。 */
export interface ActionNames {
  motions: Record<string, string> | null
  expressions: Record<string, string> | null
  moods: Record<string, string> | null
}

export interface CharacterActions {
  character_id: string
  model_path: string
  motions: { id: string; group: string; index: number; label: string; default_label: string }[]
  expressions: { id: string; label: string; default_label: string }[]
  moods: { id: string; label: string; default_label: string }[]
  action_names: ActionNames
  unavailable_motions: number
  unavailable_expressions: number
}
/** 角色跨会话记忆条目。 */
export interface CharacterMemory {
  id: string
  character_id: string
  content: string
  created_at: string
  updated_at: string
}
/** 一次对话会话。 */
export interface Conversation {
  id: string
  character_id: string
  title: string
  created_at: string
  updated_at: string
}
/** 单条消息；status 表示生成状态，失败时 error 携带原因。 */
export interface Message {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  image?: string
  error?: string
  tool_runs?: ToolRun[]
  status: 'complete' | 'failed' | 'interrupted' | 'streaming'
  created_at: string
}
/** 工具调用记录，随助手消息一起返回。 */
export interface ToolRun {
  id: string
  name: string
  status: 'running' | 'completed' | 'failed'
}
/** 应用设置；has_*_key 只表示后端是否存有密钥，密钥本身不会下发。 */
export interface Settings {
  llm: {
    provider: 'openai' | 'deepseek' | 'ollama' | 'lmstudio'
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
  llm_profile_saved?: boolean
  has_speech_key: boolean
  environment_overrides: string[]
}

export type LLMProvider = Settings['llm']['provider']
export interface LLMProfile {
  llm: Settings['llm']
  has_llm_key: boolean
  saved: boolean
}

/** Ollama 本机服务通过 /api/tags 返回的已安装模型。 */
export interface OllamaModel {
  name: string
  model: string
  size: number
  modified_at: string
  details: {
    family: string
    parameter_size: string
    quantization_level: string
  }
}
/**
 * SSE 流式事件：user 确认收到用户消息、delta 文本增量、expression 切换表情、
 * stage_action 模型动作/原生表情请求、character 已保存的角色设定、tool 工具状态、done 最终消息、error 失败。
 */
export interface StreamEvent {
  type: 'user' | 'delta' | 'expression' | 'character' | 'stage_action' | 'done' | 'error' | 'tool'
  text?: string
  expression?: string
  message?: Message
  tool?: ToolRun
  character?: Character
  stage_action?: StageAction
}

/** 已经由后端模型清单校验的舞台动作或原生表情请求。 */
export interface StageAction {
  character_id: string
  model_path: string
  type: 'motion' | 'expression'
  id: string
}
/** 用户导入的场景素材（背景或叠加层），url 为需经 mediaURL 解析的相对路径。 */
export interface SceneAsset {
  id: string
  name: string
  kind: 'image' | 'video' | 'html'
  mime_type: string
  size: number
  url: string
  created_at: string
}
