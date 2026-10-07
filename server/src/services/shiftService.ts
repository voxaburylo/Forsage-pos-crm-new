import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import { logger } from '../lib/logger.js'
import type { OpenShiftInput, CloseShiftInput } from '../validators/shiftSchema.js'


const TABLE = 'shifts'

export async function getShiftCashBreakdown(
  shiftId: string,
  tenantId: string,
  _openingCash?: number,
) {
  // Opening cash must come from the same snapshot, never from a preceding request.
  return (await getShiftReport(shiftId,tenantId)).cash_breakdown
}

export async function getCurrentShift(cashierId: string, tenantId: string) {
  const { data } = await db
    .from(TABLE)
    .select('*')
    .eq('cashier_id', cashierId)
    .eq('tenant_id', tenantId)
    .eq('status', 'open')
    .maybeSingle()
  if (data) return data

  // У браузерній касі один фізичний касовий ящик може працювати під різними
  // сесіями/ролями. Якщо для поточного auth-id зміни немає, підхоплюємо
  // відкриту зміну магазину, щоб POS не повертався на екран відкриття.
  const { data: tenantShift } = await db
    .from(TABLE)
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'open')
    .order('opened_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return tenantShift  // null якщо немає відкритої зміни
}

export async function getShift(id: string, tenantId: string) {
  const { data, error } = await db
    .from(TABLE)
    .select('*')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .single()

  if (error || !data) throw new AppError('SHIFT_NOT_FOUND', 'Зміну не знайдено', 404)
  return data
}

export async function openShift(cashierId: string, tenantId: string, input: OpenShiftInput) {
  const existing = await getCurrentShift(cashierId, tenantId)
  if (existing) throw new AppError('SHIFT_ALREADY_OPEN', 'У вас вже є відкрита зміна', 409)

  const { data, error } = await db
    .from(TABLE)
    .insert({
      tenant_id:     tenantId,
      cashier_id:    cashierId,
      status:        'open',
      opening_cash:  input.opening_cash,
      notes:         input.notes ?? null,
    })
    .select('*')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

export async function closeShift(
  shiftId: string,
  cashierId: string,
  input: CloseShiftInput,
  tenantId: string,
  userRole = 'cashier',
) {
  const shift = await getShift(shiftId, tenantId)

  const canCloseTenantShift = userRole === 'owner' || userRole === 'admin'
  if (shift.cashier_id !== cashierId && !canCloseTenantShift) {
    throw new AppError('FORBIDDEN', 'Це не ваша зміна', 403)
  }
  if (shift.status === 'closed') {
    throw new AppError('SHIFT_ALREADY_CLOSED', 'Зміна вже закрита', 409)
  }

  // Перевіряємо чи була звірка каси
  const { data: reconciliations } = await db
    .from('cash_reconciliations')
    .select('id')
    .eq('shift_id', shiftId)
    .eq('tenant_id', tenantId)
    .limit(1)

  if (!reconciliations || reconciliations.length === 0) {
    throw new AppError('RECONCILIATION_REQUIRED', 'Спочатку виконайте звірку каси', 400)
  }

  const cash = await getShiftCashBreakdown(shiftId, tenantId, shift.opening_cash)
  const expectedCash = cash.expected_amount
  const variance = input.closing_cash - expectedCash

  const { data, error } = await db
    .from(TABLE)
    .update({
      status:        'closed',
      closing_cash:  input.closing_cash,
      expected_cash: expectedCash,
      cash_variance: variance,
      closed_at:     new Date().toISOString(),
      notes:         input.notes ?? shift.notes,
    })
    .eq('id', shiftId)
    .eq('tenant_id', tenantId)
    .select('*')
    .single()

  if (error) throw new AppError('DB_ERROR', error.message, 500)
  return data
}

/**
 * Закриває зміни які відкриті >24 год і не мали продажів останні 2 год.
 * Викликається background job close_stale_shifts.
 */
export async function closeStaleShifts(): Promise<number> {
  const STALE_HOURS = 24
  const ACTIVITY_WINDOW_HOURS = 2

  const staleThreshold  = new Date(Date.now() - STALE_HOURS * 3600 * 1000).toISOString()
  const activityCutoff  = new Date(Date.now() - ACTIVITY_WINDOW_HOURS * 3600 * 1000).toISOString()

  // Знаходимо відкриті зміни старші за STALE_HOURS
  const { data: staleShifts, error: fetchErr } = await db
    .from('shifts')
    .select('id, cashier_id, tenant_id, opening_cash')
    .eq('status', 'open')
    .lt('opened_at', staleThreshold)

  if (fetchErr || !staleShifts?.length) return 0

  // Фільтруємо: пропускаємо зміни з нещодавньою активністю
  const activeShiftIds: string[] = []
  if (staleShifts.length > 0) {
    const { data: activeSales } = await db
      .from('sales')
      .select('shift_id')
      .in('shift_id', staleShifts.map(s => s.id))
      .gte('completed_at', activityCutoff)
    activeShiftIds.push(...new Set((activeSales ?? []).map(s => s.shift_id).filter(Boolean)))
  }

  const toClose = staleShifts.filter(s => !activeShiftIds.includes(s.id))
  if (!toClose.length) return 0

  const { error: closeErr } = await db
    .from('shifts')
    .update({
      status:        'closed',
      closing_cash:  null,
      expected_cash: null,
      cash_variance: null,
      closed_at:     new Date().toISOString(),
      notes:         `Автоматично закрита після ${STALE_HOURS} год неактивності`,
    })
    .in('id', toClose.map(s => s.id))

  if (closeErr) {
    logger.error({ error: closeErr.message }, 'closeStaleShifts: помилка закриття')
    return 0
  }

  logger.info({ closedCount: toClose.length }, 'closeStaleShifts: закрито застарілих змін')
  return toClose.length
}

export async function getShiftReport(shiftId: string, tenantId: string) {
  const { readShiftReport } = await import('./shiftReport.js')
  return readShiftReport(shiftId,tenantId)
}
