import type { LocalDatabase } from '../db/localDatabase'

/**
 * 24.11.2026 (план C9, «журнал відправлених операцій»). Журнал займає ~24 МБ із 107 МБ бази каси й росте ~5 МБ/міс.
 * Що можна чистити, не ламаючи захисні перевірки (розібрано по коду 24.11):
 *  - рядки НЕ видаляються: на номер рядка й ідентифікатор операції спираються повтор чека, відновлення ревізії,
 *    журнал проблем, перевірки копій — тож лишаються всі рядки й усі поля, крім вмісту;
 *  - вміст стискається лише в ТОЧНО відправлених (synced) рядках, старших за 90 днів, і лише тих видів, чий вміст
 *    після відправлення ніхто не читає: картка товару, бренд, накладна, початок ревізії, налаштування;
 *  - НЕ чіпаємо: продажі (sale.completed), повернення (return.created — з нього звіт зміни бере звʼязок зі зміною),
 *    завершені ревізії (inventory.completed — з них відновлюється копія ревізії), зарплату, зміни, гроші, PIN.
 * Запускає лише власник кнопкою, з попереднім підрахунком. Файл бази після цього не зменшується одразу —
 * звільнене місце SQLite займає новими записами, тож база просто перестає рости за рахунок журналу.
 */
export const COMPACTABLE_TYPES = [
  'product.upsert', 'brand.upsert', 'category.upsert',
  'supplier_invoice.created', 'supplier_invoice.updated', 'supplier_invoice.posted', 'supplier_invoice.payment_added',
  'inventory.created', 'inventory.started', 'settings.updated',
] as const
export const COMPACT_AFTER_DAYS = 90
const COMPACTED = '{"compacted":true}'

export interface OutboxCompactionPreview { rows: number; bytes: number; older_than: string; journal_rows: number; journal_bytes: number }

function cutoff(now: Date): string {
  return new Date(now.getTime() - COMPACT_AFTER_DAYS * 86_400_000).toISOString()
}

const WHERE = `status = 'synced' AND created_at < ? AND payload_json <> '${COMPACTED}'
  AND operation_type IN (${COMPACTABLE_TYPES.map(type => `'${type}'`).join(', ')})`

export function previewOutboxCompaction(db: LocalDatabase, now = new Date()): OutboxCompactionPreview {
  const olderThan = cutoff(now)
  const target = db.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(length(payload_json)), 0) AS bytes FROM sync_outbox WHERE ${WHERE}`).get(olderThan) as { rows: number; bytes: number }
  const all = db.prepare('SELECT COUNT(*) AS rows, COALESCE(SUM(length(payload_json)), 0) AS bytes FROM sync_outbox').get() as { rows: number; bytes: number }
  return { rows: Number(target.rows), bytes: Number(target.bytes), older_than: olderThan, journal_rows: Number(all.rows), journal_bytes: Number(all.bytes) }
}

/** Стиснути. Повертає, скільки рядків і байтів звільнено; повтор нічого не змінює. */
export function compactOutbox(db: LocalDatabase, now = new Date()): { rows: number; bytes: number } {
  const olderThan = cutoff(now)
  let result = { rows: 0, bytes: 0 }
  db.transaction(() => {
    const before = db.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(length(payload_json)), 0) AS bytes FROM sync_outbox WHERE ${WHERE}`).get(olderThan) as { rows: number; bytes: number }
    db.prepare(`UPDATE sync_outbox SET payload_json = ? WHERE ${WHERE}`).run(COMPACTED, olderThan)
    result = { rows: Number(before.rows), bytes: Math.max(0, Number(before.bytes) - Number(before.rows) * COMPACTED.length) }
  })
  return result
}
