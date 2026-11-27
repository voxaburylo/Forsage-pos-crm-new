import { api } from '@/lib/api'
import type { LoadProgress } from '@/features/settings/LoadRing'
import { aiActionOperationId } from './aiActionOperation'
import { applyAgentItems, NAME_SAVED_NOTE, planChatCatalogUpdates, type ChatCatalogBridge, type ChatCatalogUpdate } from './aiCatalogApply'

/**
 * 26.11.2026, слово власника: «по 200 за раз дуже довго; товарів мільйони; хай працює на сервері у фоні».
 * Фонові задачі помічника: сервер чистить/перекладає назви пачками сам, власник лише запускає й переглядає.
 */
export type JobStatus = 'ready' | 'running' | 'paused' | 'review' | 'done' | 'cancelled'
export interface AiJob {
  id: string; target: 'products' | 'supplier_offers'; task: 'cleanup' | 'translate' | 'cleanup_translate'; filter: string; connection_id: string | null
  title: string; status: JobStatus; total: number; processed: number; changed: number; suspicious: number; applied: number; cost_usd: number
  last_error: string | null; created_at: string; updated_at: string; estimate: { cost_usd: number; minutes: number }; progress: LoadProgress
}
export type JobItemState = 'proposed' | 'suspicious' | 'unchanged' | 'applied' | 'rejected' | 'failed' | 'pending'
export interface AiJobItem { item_key: string; seq: number; old_name: string; sku: string | null; new_name: string | null; new_sku: string | null; state: JobItemState; note: string | null }

const BASE = '/api/v1/ai/jobs'
const quiet = { silent: true, timeoutMs: 30_000 }
export const aiJobsApi = {
  list: () => api.get<{ data: AiJob[] }>(BASE, quiet),
  create: (body: { target: AiJob['target']; task: AiJob['task']; filter: string; connection_id?: string }) => api.post<{ data: AiJob }>(BASE, body, undefined, { silent: true, timeoutMs: 120_000 }),
  action: (id: string, action: 'start' | 'pause' | 'cancel') => api.post<{ data: AiJob }>(`${BASE}/${id}/${action}`, {}, undefined, quiet),
  items: (id: string, state: JobItemState, page: number, perPage = 100) =>
    api.get<{ data: { items: AiJobItem[]; counts: Partial<Record<JobItemState, number>> } }>(`${BASE}/${id}/items?state=${state}&page=${page}&per_page=${perPage}`, quiet),
  setItems: (id: string, to: 'approve' | 'reject', keys: string[]) => api.post<{ data: { changed: number } }>(`${BASE}/${id}/items/${to}`, { keys }, undefined, quiet),
  applyOffers: (id: string) => api.post<{ data: { applied: number } }>(`${BASE}/${id}/apply-offers`, {}, undefined, { silent: true, timeoutMs: 120_000 }),
  markApplied: (id: string, applied: string[], failed: Array<{ key: string; error: string }>) => api.post<{ data: AiJob }>(`${BASE}/${id}/applied`, { applied, failed }, undefined, quiet),
}

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  ready: 'готова до запуску', running: 'працює', paused: 'на паузі', review: 'готово — перегляньте', done: 'завершено', cancelled: 'скасовано',
}

const toUuid = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`

/**
 * Одна пачка до 500 готових назв наших товарів → головний ПК тим самим захищеним шляхом, що й пропозиції чату
 * (відбиток картки, резервна копія, переклад не змінює цифр). Повертає, що записано і що ПК відхилив (з причиною).
 */
export async function applyProductChunk(job: Pick<AiJob, 'id' | 'task'>, items: readonly AiJobItem[], bridge: ChatCatalogBridge): Promise<{ applied: string[]; failed: Array<{ key: string; error: string }> }> {
  const updates: ChatCatalogUpdate[] = items.map(item => ({ product_id: item.item_key, new_name: item.new_name ?? undefined, new_sku: item.new_sku ?? undefined, cleanup: job.task !== 'translate' }))
  const fingerprints = await bridge.agentFingerprints(items.map(item => item.item_key))
  const known = new Set(fingerprints.filter(row => row.fingerprint).map(row => row.product_id))
  const failed: Array<{ key: string; error: string }> = items.filter(item => !known.has(item.item_key)).map(item => ({ key: item.item_key, error: 'Товар не знайдено в базі каси (видалено?)' }))
  const plan = planChatCatalogUpdates(updates.filter(update => known.has(update.product_id)), fingerprints, [])
  const planned = new Set(plan.items.map(item => item.product_id))
  // Назва вже така сама — вважаємо застосованим.
  const applied = items.filter(item => known.has(item.item_key) && !planned.has(item.item_key)).map(item => item.item_key)
  if (plan.items.length) {
    const ids = plan.items.map(item => item.product_id).sort().join(',')
    const result = await applyAgentItems(bridge, plan.items, async attempt => toUuid(await aiActionOperationId('ai-job:' + job.id, ids + (attempt ? ':names-only' : ''))))
    const skipped = new Map((result.skipped ?? []).map(row => [row.product_id, row.error]))
    for (const id of planned) {
      const reason = skipped.get(id)
      // «Назву змінено, артикул не поставлено» — назва записана: це застосовано, а не відмова.
      if (reason && !reason.startsWith(NAME_SAVED_NOTE)) failed.push({ key: id, error: reason }); else applied.push(id)
    }
  }
  return { applied, failed }
}
