import { api } from '@/lib/api'
import { writesToMainPc } from '@/lib/mainPcData'
import { applyLocalAiAction } from './localAiAction'
import { aiRequestHistory } from './aiRequestHistory'

export const AI_MODELS = ['claude-sonnet-5-5'] as const
export type AiModel = (typeof AI_MODELS)[number]

export const AI_MODEL_LABELS: Record<AiModel, string> = {
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
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

/** Фото йде через тимчасове сховище; PDF накладної — напряму в base64. */
export type AiChatImage =
  | { mime_type: 'image/jpeg' | 'image/png' | 'image/webp'; storage_path: string }
  | { mime_type: 'application/pdf'; data_base64: string }

export interface AiApplyResult {
  result: {
    created?: number
    failed?: number
    errors?: Array<{ item: string; error: string }>
    [k: string]: any
  }
}

export type { AiChatProgress } from './aiProgress'
import type { AiChatProgress } from './aiProgress'

export interface AiChatResponse {
  reply: string
  actions: AiPendingAction[]
  usage: { prompt_tokens: number; completion_tokens: number; cost_usd: number }
}

export interface AiRule { id: string; text: string; created_at: string; created_by: string | null }

export interface AiChatMessage {
  role: 'user' | 'model'
  text: string
}

export const aiApi = {
  reviewCatalog: (body: { products: Array<{ id: string; name: string; sku: string; brand: string; category_id: string | null }>; categories: Array<{ id: string; name: string }> }) =>
    api.post<{ data: { proposals: Array<{ id: string; name: string; sku: string; category_id: string | null; reason: string }> } }>('/api/v1/ai/catalog-review', body, undefined, { timeoutMs: 120000, silent: true }),
  status: () => api.get<{ data: AiStatus }>('/api/v1/ai/status', { silent: true, timeoutMs: 15_000 }),
  /** Офіційний курс НБУ на сьогодні. */
  nbuRate: (currency: string) => api.get<{ data: { currency: string; rate: number; date: string } }>('/api/v1/ai/nbu-rate?currency=' + encodeURIComponent(currency), { silent: true, timeoutMs: 15_000 }),
  usage:  () => api.get<{ data: AiUsage }>('/api/v1/ai/usage'),
  rules: () => api.get<{ data: AiRule[] }>('/api/v1/ai/memory', { silent: true, timeoutMs: 15_000 }),
  addRule: (text: string) => api.post<{ data: AiRule[] }>('/api/v1/ai/memory', { text }),
  deleteRule: (id: string) => api.delete<{ data: AiRule[] }>('/api/v1/ai/memory/' + encodeURIComponent(id)),

  saveConfig: (body: { api_key?: string | null; model?: AiModel; enabled?: boolean }) =>
    api.post<{ data: { enabled: boolean; model: AiModel; has_key: boolean } }>('/api/v1/ai/config', body),

  test: (body?: { api_key?: string; model?: AiModel }) =>
    api.post<{ data: { ok: boolean } }>('/api/v1/ai/test', body ?? {}),

  chat: (body: { message: string; history?: AiChatMessage[]; file_text?: string; images?: AiChatImage[] }, onProgress?: (event: AiChatProgress) => void) =>
    api.post<{ data: AiChatResponse }>('/api/v1/ai/chat', { ...body, history: body.history ? aiRequestHistory(body.history) : undefined },
      onProgress ? { 'X-AI-Progress': '1' } : undefined, {
      timeoutMs: 600000, silent: true,
      ...(onProgress ? { onProgressLine: (event: unknown) => onProgress(event as AiChatProgress) } : {}),
    }),

  recognizeSupplyInvoice: (body: { message?: string; images: AiChatImage[] }) =>
    api.post<{ data: AiChatResponse }>('/api/v1/ai/supply-invoice-photo', body, undefined, { timeoutMs: 180000, silent: true }),

  applyAction: (body: { tool: string; payload: Record<string, any>; operation_id?: string }): Promise<{ data: AiApplyResult }> =>
    writesToMainPc() ? applyLocalAiAction(body.tool, body.payload, body.operation_id) : api.post<{ data: AiApplyResult }>('/api/v1/ai/apply-action', body),
}
