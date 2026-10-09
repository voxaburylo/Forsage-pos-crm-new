import type { LocalDatabase } from '../db/localDatabase'
import { validateSupplierCatalogManifest, type SupplierCatalogManifest } from '../lib/supplierCatalogManifest'
import { SERVER_PULL_SCOPE } from './syncPullCompletion'
import { SERVER_RESET_GENERATION_KEY } from './localTenantReset'

type CopyKind = 'pull' | 'bootstrap'
type CheckedCopy = {
  cursor: bigint
  since: bigint | null
  mode: 'full' | 'delta'
  generation: number
}
const invalid = () => new Error('Несумісна копія даних. Нічого не записано; перевірте версії програми та сервера.')
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** Preserve microseconds when comparing server cursors, including timezone offsets. */
function instant(value: unknown): bigint | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value)
  if (!match) return null
  const local = Date.parse(match[1] + 'Z'), epoch = Date.parse(value)
  if (!Number.isFinite(local) || !Number.isFinite(epoch)
    || new Date(local).toISOString().slice(0, 19) !== match[1]) return null
  return BigInt(epoch) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0').slice(3))
}

/** Strict remote boundary. Internal trusted chunks intentionally keep their own legacy adapter. */
export function assertIncomingCopyContract(input: unknown, kind: CopyKind, expectedTenantId: string): CheckedCopy {
  if (!object(input) || typeof expectedTenantId !== 'string' || !expectedTenantId.trim() || input.tenant_id !== expectedTenantId) throw invalid()
  // Server reset is never authority to clear the store's master database.
  if (input.reset_required === true) {
    throw new Error('Сервер просить скинути дані. Автоматичне очищення локальної бази заборонено.')
  }
  if (input.reset_required !== false) throw invalid()
  if (!Number.isSafeInteger(input.reset_generation) || Number(input.reset_generation) < 0) throw invalid()
  const rawCursor = kind === 'pull' ? input.cursor : input.exported_at
  const cursor = instant(rawCursor)
  if (cursor === null) throw invalid()
  const manifest = input.supplier_catalog_copy
  if (!object(manifest) || manifest.version !== 1) {
    throw new Error('Копія не має підтримуваного контрольного опису прайсу версії 1. Нічого не записано; потрібні сумісні версії програми та сервера.')
  }
  if (kind === 'bootstrap' && manifest.mode !== 'full') {
    throw new Error('Початкова копія має бути повною. Вибірку змін замість неї не застосовано.')
  }
  const since = manifest.mode === 'delta' ? instant(manifest.since) : null
  if (manifest.mode === 'delta' && since === null) throw invalid()
  validateSupplierCatalogManifest(input, expectedTenantId, rawCursor as string)
  // Date.parse in the compatible v1 digest truncates sub-millisecond precision.
  if (since !== null && since > cursor) throw invalid()
  return { cursor, since, mode: (manifest as SupplierCatalogManifest).mode, generation: input.reset_generation as number }
}

/** Read-only continuity check, before markPullAttempt or any data mutation. */
export function assertIncomingCopyContinuity(db: LocalDatabase, copy: CheckedCopy): void {
  const storedGeneration = db.prepare('SELECT value_json FROM app_meta WHERE key=?').get(SERVER_RESET_GENERATION_KEY) as
    { value_json: string } | undefined
  let generation: unknown = 0
  try { if (storedGeneration) generation = JSON.parse(storedGeneration.value_json) } catch { throw invalid() }
  if (!Number.isSafeInteger(generation) || Number(generation) < 0) throw invalid()
  if (generation !== copy.generation) {
    throw new Error('Копія не відповідає збереженій версії серверної бази. Потрібна звірка; локальні дані не змінено.')
  }
  const state = db.prepare('SELECT pull_cursor FROM sync_state WHERE scope=?').get(SERVER_PULL_SCOPE) as
    { pull_cursor: string | null } | undefined
  const previous = state?.pull_cursor == null ? null : instant(state.pull_cursor)
  if (state?.pull_cursor != null && previous === null) throw invalid()
  if (previous !== null && copy.cursor < previous) {
    throw new Error('Копія старіша за вже застосовані дані. Дату обміну назад не змінено.')
  }
  // Overlap is safe for retry; an unreceived gap is not.
  if (copy.mode === 'delta' && (previous === null || copy.since === null || copy.since > previous)) {
    throw new Error('У копії пропущено проміжок змін. Потрібна повна копія; дані не застосовано.')
  }
}
