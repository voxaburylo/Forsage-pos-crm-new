import type { CleanupMergeInput, CleanupPreview } from '@/features/admin/catalogCleanupModel'

/**
 * Об'єднання дублів, запропоноване в чаті помічника (merge_products_bulk), на касі.
 * Кожна пара йде тим самим шляхом, що й «Об’єднати вручну»: свіжа перевірка карток (заборони,
 * історія, штрихкоди), потім запис із резервною копією. Пара, яку не можна об'єднати, пропускається
 * з причиною; решта записуються. Облікова кількість — сума карток, фактичний залишок не змінюється.
 */
export interface ChatMerge { primary_product_id?: unknown; duplicate_product_id?: unknown; reason?: unknown }
export interface ChatMergeBridge {
  cleanupPreview: (input: { target_id: string; source_ids: string[]; stock_review: 'pending' | 'checked' }) => Promise<CleanupPreview>
  cleanupApply: (input: CleanupMergeInput & { operation_id: string }) => Promise<{ quantity_after: number; backupPath?: string }>
}
export interface ChatMergeResult { merged: number; skipped: Array<{ item: string; error: string }>; backupPath: string }

const label = (preview: CleanupPreview | null, id: string) => preview?.products.find(product => product.id === id)?.name ?? id

export async function applyChatMerges(
  merges: readonly ChatMerge[],
  bridge: ChatMergeBridge,
  operationId: (index: number) => Promise<string>,
): Promise<ChatMergeResult> {
  const result: ChatMergeResult = { merged: 0, skipped: [], backupPath: '' }
  const gone = new Set<string>()
  for (const [index, merge] of merges.entries()) {
    const target = String(merge?.primary_product_id ?? ''), source = String(merge?.duplicate_product_id ?? '')
    if (!target || !source || target === source) { result.skipped.push({ item: source || target || '—', error: 'Некоректна пара карток' }); continue }
    if (gone.has(target) || gone.has(source)) { result.skipped.push({ item: source, error: 'Картку вже об’єднано в цьому ж пакеті' }); continue }
    let preview: CleanupPreview | null = null
    try {
      preview = await bridge.cleanupPreview({ target_id: target, source_ids: [source], stock_review: 'pending' })
      if (!preview.can_apply || preview.blockers.length || !preview.fingerprint) {
        result.skipped.push({ item: label(preview, source), error: preview.blockers.join(' · ') || 'Ці картки не можна об’єднати' })
        continue
      }
      const reason = (typeof merge.reason === 'string' && merge.reason.trim() ? merge.reason.trim() : 'Дубль за пропозицією ШІ-помічника')
        .slice(0, 900) + ' (підтверджено власником у чаті)'
      const saved = await bridge.cleanupApply({
        target_id: target, source_ids: [source], stock_review: preview.stock_review,
        preview_fingerprint: preview.fingerprint, reason, operation_id: await operationId(index),
      })
      result.merged += 1
      result.backupPath = saved?.backupPath ?? result.backupPath
      gone.add(source)
    } catch (error) {
      result.skipped.push({ item: label(preview, source), error: error instanceof Error ? error.message : 'Не вдалося об’єднати' })
    }
  }
  return result
}
