import { api } from '@/lib/api'

/**
 * Масова робота над текстами товарів для сайту (26.11.2026): 10 зразків → одне «годиться» → сервер сам проходить усі товари.
 * Тут — типи, виклики сервера й слова для екрана (спокійні, без «помилка!» і червоного).
 */
export type TextJobStatus = 'sample' | 'sample_ready' | 'running' | 'paused' | 'reverting' | 'done' | 'cancelled'
export interface TextJob {
  id: string; scope: 'in_stock' | 'all'; overwrite: boolean; style_note: string | null; status: TextJobStatus
  total: number; processed: number; written: number; review: number; skipped: number; failed: number
  cost_usd: number; last_error: string | null; progress: number; created_at: string; updated_at: string
}
export interface TextItem { product_id: string; name: string; state: string; note: string | null; new_fields: { description?: string; seo_title?: string; seo_description?: string } | null }
export type TextJobAction = 'approve_sample' | 'redo_sample' | 'pause' | 'resume' | 'cancel' | 'revert' | 'retry_failed' | 'write_review' | 'reject_review'

const BASE = '/api/v1/site-admin/text-jobs'
export const textJobsApi = {
  list: async () => (await api.get<{ data: TextJob[] }>(BASE, { silent: true })).data,
  create: async (input: { scope: 'in_stock' | 'all'; overwrite: boolean; style_note?: string }) => (await api.post<{ data: TextJob }>(BASE, input, undefined, { silent: true })).data,
  action: async (id: string, action: TextJobAction, extra: { style_note?: string; product_ids?: string[] } = {}) =>
    (await api.post<{ data: TextJob }>(`${BASE}/${id}/action`, { action, ...extra }, undefined, { silent: true })).data,
  items: async (id: string, state: 'sample' | 'review' | 'written' | 'failed', page = 1) =>
    (await api.get<{ data: { items: TextItem[] } }>(`${BASE}/${id}/items?state=${state}&page=${page}`, { silent: true })).data.items,
}

export const isOpen = (job: TextJob | null | undefined) => Boolean(job && ['sample', 'sample_ready', 'running', 'paused', 'reverting'].includes(job.status))
const count = (value: number) => value.toLocaleString('uk-UA')

/** Один рядок про стан — що відбувається і чи треба щось від власника. */
export function textJobLine(job: TextJob): string {
  const left = Math.max(0, job.total - job.processed)
  const parts = [`на сайті ${count(job.written)}`, job.skipped ? `уже мали опис ${count(job.skipped)}` : '', job.review ? `відкладено на ваш погляд ${count(job.review)}` : '', job.failed ? `не вдалося ${count(job.failed)}` : ''].filter(Boolean).join(' · ')
  switch (job.status) {
    case 'sample': return `Готую 10 зразків із ${count(job.total)} товарів — хвилина-дві. На сайт поки нічого не записано.`
    case 'sample_ready': return `Зразки готові. Подивіться — і якщо стиль підходить, далі я пройду всі ${count(job.total)} товарів сам.`
    case 'running': return `Працюю: ${count(job.processed)} з ${count(job.total)} (${job.progress}%) · ${parts}. Екран можна закрити — сервер працює сам${left ? `, лишилось приблизно ${etaText(left)}` : ''}.`
    case 'paused': return `На паузі: ${count(job.processed)} з ${count(job.total)} · ${parts}.` + (job.last_error ? ' ' + job.last_error : '')
    case 'reverting': return `Повертаю на сайт попередні тексти: лишилось ${count(job.written)}.`
    case 'done': return `Готово: ${parts}.`
    case 'cancelled': return job.written ? `Зупинено: ${parts}.` : 'Скасовано. На сайті — як було.'
  }
}
/** Приблизно 24 товари за хвилину (6 пачок по 4). Чесна оцінка, не обіцянка. */
export function etaText(left: number): string {
  const minutes = Math.ceil(left / 24)
  return minutes < 60 ? `${minutes} хв` : `${Math.round(minutes / 6) / 10} год`.replace('.', ',')
}
