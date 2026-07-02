import { api } from '@/lib/api'

export const AI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'] as const
export type AiModel = (typeof AI_MODELS)[number]

export const AI_MODEL_LABELS: Record<AiModel, string> = {
  'gemini-2.5-flash': 'Gemini 2.5 Flash (швидка, дешева)',
  'gemini-2.5-pro':   'Gemini 2.5 Pro (розумніша, дорожча)',
  'gemini-2.0-flash': 'Gemini 2.0 Flash (найдешевша)',
}

export interface AiUsage {
  month: string
  requests: number
  total_tokens: number
  cost_usd: number
}

export interface AiStatus {
  enabled: boolean
  model: AiModel
  has_key: boolean
  usage: AiUsage
}

export interface AiActionChange {
  label: string
  old: string | null
  next: string
}

export interface AiPendingAction {
  id: string
  tool: string
  title: string
  changes: AiActionChange[]
  payload: Record<string, any>
  // масові дії
  count?: number
  columns?: string[]
  items?: Array<Record<string, string>>
  // замовлення з фото: поля, розпізнані невпевнено
  uncertain?: string[]
}

export interface AiChatImage {
  mime_type: 'image/jpeg' | 'image/png' | 'image/webp'
  data_base64: string
}

export interface AiApplyResult {
  result: {
    created?: number
    failed?: number
    errors?: Array<{ item: string; error: string }>
    [k: string]: any
  }
}

export interface AiChatResponse {
  reply: string
  actions: AiPendingAction[]
  usage: { prompt_tokens: number; completion_tokens: number; cost_usd: number }
}

export interface AiChatMessage {
  role: 'user' | 'model'
  text: string
}

export const aiApi = {
  status: () => api.get<{ data: AiStatus }>('/api/v1/ai/status'),
  usage:  () => api.get<{ data: AiUsage }>('/api/v1/ai/usage'),

  saveConfig: (body: { api_key?: string | null; model?: AiModel; enabled?: boolean }) =>
    api.post<{ data: { enabled: boolean; model: AiModel; has_key: boolean } }>('/api/v1/ai/config', body),

  test: (body?: { api_key?: string; model?: AiModel }) =>
    api.post<{ data: { ok: boolean } }>('/api/v1/ai/test', body ?? {}),

  chat: (body: { message: string; history?: AiChatMessage[]; file_text?: string; images?: AiChatImage[] }) =>
    api.post<{ data: AiChatResponse }>('/api/v1/ai/chat', body, undefined, { timeoutMs: 180000 }),

  applyAction: (body: { tool: string; payload: Record<string, any> }) =>
    api.post<{ data: AiApplyResult }>('/api/v1/ai/apply-action', body),
}
