/**
 * Спільна основа синхронізації: типи операцій, константи і дрібні помічники,
 * якими користуються і читання (pull), і застосування операцій (push).
 *
 * Винесено з `syncService.ts`, який виріс до 4923 рядків. У файлі такого
 * розміру помилку не видно очима — саме там ховалися і забутий бренд, і
 * забутий постачальник. Поведінка не змінена: це перестановка коду.
 */
import { randomUUID } from 'node:crypto'
import { db } from '../../db/supabase.js'
import { pool } from '../../db/pg.js'
import { AppError } from '../../middleware/errorHandler.js'
import { isSyncOperationAllowed, sanitizeShopSettingsForRole } from '../syncRolePolicy.js'

export const ORDER_STATUS_TRANSITIONS: Record<string, string[]> = {
  lead: ['new', 'in_progress', 'ordered'],
  quoted: ['new', 'in_progress', 'ordered'],
  new: ['in_progress', 'ordered'],
  in_progress: ['new', 'ordered'],
  ordered: ['new'],
  arrived: ['called', 'no_answer'],
  ready: ['called', 'no_answer'],
  called: ['no_answer', 'ready'],
  no_answer: ['called', 'ready'],
}

export const IN_FILTER_CHUNK = 200
export const CURSOR_OVERLAP_MS = 5_000

export type SyncGenerationState = {
  cursor: string
  generation: number
  resetAt: string | null
}

export function databaseTimestamp(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  if (!Number.isFinite(parsed.getTime())) return null
  return parsed.toISOString()
}

// Release order is migration -> server. The generation table and all delta
// columns must exist before this code is exposed; silently serving a partial
// schema would make the cursor contract dishonest.
export async function captureSyncState(tenantId: string): Promise<SyncGenerationState> {
  try {
    const result = await pool.query<{
      cursor: Date | string
      generation: string | number
      reset_at: Date | string | null
    }>(
      `SELECT stamp.server_now - ($1::integer * interval '1 millisecond') AS cursor,
              COALESCE(state.generation, 0) AS generation,
              state.reset_at
       FROM (SELECT clock_timestamp() AS server_now) AS stamp
       LEFT JOIN sync_tenant_generations AS state ON state.tenant_id = $2`,
      [CURSOR_OVERLAP_MS, tenantId],
    )
    const row = result.rows[0]
    const cursor = databaseTimestamp(row?.cursor)
    if (!cursor) throw new Error('database returned an invalid cursor')
    return {
      cursor,
      generation: Number(row?.generation ?? 0),
      resetAt: databaseTimestamp(row?.reset_at),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new AppError('DB_ERROR', `Не вдалося отримати стан синхронізації: ${message}`, 500)
  }
}
export async function captureDatabaseAppliedAt(): Promise<string> {
  try {
    const result = await pool.query<{ applied_at: Date | string }>(
      'SELECT clock_timestamp() AS applied_at',
    )
    const appliedAt = databaseTimestamp(result.rows[0]?.applied_at)
    if (!appliedAt) throw new Error('database returned an invalid apply timestamp')
    return appliedAt
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new AppError('DB_ERROR', `Не вдалося отримати час застосування операції: ${message}`, 500)
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export function uuidOr(value: unknown, fallback: string): string {
  return isUuid(value) ? value : fallback
}

export function normalizedPhoneEmail(value: unknown): string {
  const digits = String(value ?? '').replace(/\D/g, '')
  return `${digits || randomUUID()}@forsage.internal`
}

export const SHOP_SETTINGS_SYNC_KEYS = [
  'shop_name', 'shop_address', 'phone', 'max_discount_pct', 'allow_negative_qty',
  'return_days', 'default_debt_limit_kopecks', 'label_settings', 'pos_quick_items',
  'markup_rules', 'price_rounding_enabled', 'price_rounding_step', 'price_rounding_dir',
  'quick_percents', 'employee_discount_pct', 'vin_decoder_url', 'vin_decoder_api_key',
  'auto_print_receipt', 'receipt_width_mm', 'owner_telegram_chat_id',
] as const


export function pickShopSettingsPayload(payload: Record<string, any> | null | undefined): Record<string, any> {
  const updates: Record<string, any> = {}
  if (!payload || typeof payload !== 'object') return updates
  for (const key of SHOP_SETTINGS_SYNC_KEYS) {
    if (payload[key] !== undefined) updates[key] = payload[key]
  }
  return updates
}

export async function fetchShopSettings(tenantId: string, role: string): Promise<Record<string, any> | null> {
  const [settingsResult, tiersResult, markupsResult] = await Promise.all([
    db.from('shop_settings').select('*').eq('tenant_id', tenantId).maybeSingle(),
    db.from('price_tiers').select('id,name,discount_pct,is_default,sort_order,created_at')
      .eq('tenant_id', tenantId).order('sort_order', { ascending: true }),
    role === 'cashier'
      ? Promise.resolve({ data: [], error: null })
      : db.from('category_markups').select('id,category_id,markup_pct,min_markup_pct,created_at')
          .eq('tenant_id', tenantId),
  ])
  if (settingsResult.error) throw new AppError('DB_ERROR', settingsResult.error.message, 500)
  if (tiersResult.error) throw new AppError('DB_ERROR', tiersResult.error.message, 500)
  if (markupsResult.error) throw new AppError('DB_ERROR', markupsResult.error.message, 500)
  const safe = sanitizeShopSettingsForRole(settingsResult.data as Record<string, any> | null, role)
  if (!safe) return null
  return {
    ...safe,
    price_tiers: tiersResult.data ?? [],
    ...(role === 'cashier' ? {} : { category_markups: markupsResult.data ?? [] }),
  }
}

export async function loadAvailability(productIds: string[]): Promise<Map<string, { qty_reserved: number; qty_available: number }>> {
  const result = new Map<string, { qty_reserved: number; qty_available: number }>()
  for (let start = 0; start < productIds.length; start += IN_FILTER_CHUNK) {
    const ids = productIds.slice(start, start + IN_FILTER_CHUNK)
    if (ids.length === 0) continue
    const { data, error } = await db
      .from('products_available')
      .select('product_id,qty_reserved,qty_available')
      .in('product_id', ids)
    if (error) throw new AppError('DB_ERROR', error.message, 500)
    for (const row of data ?? []) {
      result.set(row.product_id, {
        qty_reserved: Number(row.qty_reserved ?? 0),
        qty_available: Number(row.qty_available ?? 0),
      })
    }
  }
  return result
}

export interface SyncChangesInput {
  since?: string
  tenantId: string
  userId: string
  role: string
  includeReferences?: boolean
  resetGeneration?: number
}

export interface SyncOutboxOperation {
  sequence: number
  operation_id: string
  tenant_id: string
  device_id: string
  aggregate_type: string
  aggregate_id: string
  operation_type: string
  payload: any
  created_at: string
  applied_at?: string
}

export interface SyncPushResult {
  sequence: number
  operation_id: string
  status: 'synced' | 'failed' | 'discarded'
  aggregate_id?: string
  error?: string
  error_code?: 'SYNC_RESET_REQUIRED'
  reset_generation?: number
  reset_at?: string
}

export function assertSyncOperationAllowed(role: string, operationType: string): void {
  if (!isSyncOperationAllowed(role, operationType)) {
    throw new AppError('FORBIDDEN', 'Недостатньо прав для цієї операції синхронізації', 403)
  }
}
