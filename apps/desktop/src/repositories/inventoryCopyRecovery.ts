import type { LocalDatabase } from '../db/localDatabase'
import { LocalProblemRepository } from './problemRepository'

type Candidate = { sequence: number; tenant_id: string; aggregate_id: string; payload_json: string }
type CountedItem = { product_id: string; expected_stock: number; counted_stock: number }

function finiteValue(value: unknown): number | null {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** Restore only explicit legacy discards. Never replay inventory stock writes or guess missing history. */
export function recoverInventoryDocumentCopies(db: LocalDatabase): { queued: number; skipped: number } {
  const queued: Candidate[] = []
  const skipped: Candidate[] = []
  db.transaction(() => {
    const candidates = db.prepare(`
      SELECT sequence, tenant_id, aggregate_id, payload_json FROM sync_outbox
      WHERE operation_type = 'inventory.completed' AND status = 'synced'
        AND (last_error LIKE 'Знято з черги: сервер не прийме її ніколи.%'
          OR last_error = 'Застарілу ревізію без базового залишку пропущено без повторного застосування')
    `).all() as Candidate[]
    for (const candidate of candidates) {
      let payload: any
      try { payload = JSON.parse(candidate.payload_json) } catch { skipped.push(candidate); continue }
      const session = db.prepare(`SELECT id FROM inventory_sessions
        WHERE id = ? AND tenant_id = ? AND status = 'completed' AND deleted_at IS NULL`)
        .get(candidate.aggregate_id, candidate.tenant_id)
      if (!session || !Array.isArray(payload?.items) || !payload.items.length
        || (payload.id !== undefined && payload.id !== candidate.aggregate_id)) {
        skipped.push(candidate); continue
      }
      const localItems = db.prepare(`SELECT product_id, expected_stock, counted_stock FROM inventory_items
        WHERE session_id = ? AND tenant_id = ? AND was_counted = 1 AND deleted_at IS NULL`)
        .all(candidate.aggregate_id, candidate.tenant_id) as CountedItem[]
      const byProduct = new Map(localItems.map(item => [item.product_id, item]))
      const seen = new Set<string>()
      const restoredBase: string[] = []
      const matches = payload.items.length === localItems.length && payload.items.every((item: any) => {
        if (!item || typeof item.product_id !== 'string' || seen.has(item.product_id)) return false
        seen.add(item.product_id)
        const local = byProduct.get(item.product_id)
        const missingBase = item.expected_stock === undefined || item.expected_stock === null
        const expected = finiteValue(missingBase ? local?.expected_stock : item.expected_stock)
        const counted = finiteValue(item.counted_stock)
        if (local && missingBase && expected !== null) restoredBase.push(item.product_id)
        return local && expected !== null && counted !== null && counted >= 0
          && expected === Number(local.expected_stock) && counted === Number(local.counted_stock)
      })
      if (!matches) { skipped.push(candidate); continue }
      const payloadJson = restoredBase.length ? JSON.stringify({ ...payload,
        items: payload.items.map((item: any) => restoredBase.includes(item.product_id)
          ? { ...item, expected_stock: Number(byProduct.get(item.product_id)!.expected_stock) } : item),
        document_copy_recovery: { expected_stock_from_local: restoredBase },
      }) : candidate.payload_json
      db.prepare(`UPDATE sync_outbox SET operation_type = 'inventory.document_copied',
        status = 'pending', synced_at = NULL, attempts = 0, next_attempt_at = NULL,
        payload_json = ?,
        last_error = 'Відновлено чергу копіювання раніше пропущеної ревізії; очікує підтвердження сервера'
        WHERE sequence = ?`).run(payloadJson, candidate.sequence)
      queued.push(candidate)
    }
  })
  const problems = new LocalProblemRepository(db)
  for (const candidate of queued) {
    problems.record({ source: 'sync', code: 'sync.inventory_copy_restored', severity: 'warning',
      title: 'Відновлено передачу документа ревізії',
      detail: 'Раніше документ було пропущено. Копія очікує сервера; локальні залишки не змінено.',
      tenant_id: candidate.tenant_id, entity_type: 'inventory_session', entity_id: candidate.aggregate_id })
  }
  for (const candidate of skipped) {
    problems.record({ source: 'sync', code: 'sync.inventory_copy_needs_review', severity: 'warning',
      title: 'Стара ревізія потребує перевірки серверної копії',
      detail: 'Не вдалося однозначно звірити пропущений документ із завершеною локальною ревізією. Дані не змінено; автоматичне повторне проведення заборонено.',
      tenant_id: candidate.tenant_id, entity_type: 'inventory_session', entity_id: candidate.aggregate_id })
  }
  return { queued: queued.length, skipped: skipped.length }
}
