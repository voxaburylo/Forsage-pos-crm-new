import { db } from '../db/supabase.js'
import { AppError } from '../middleware/errorHandler.js'
import { logger } from '../lib/logger.js'
import type { OpenShiftInput, CloseShiftInput } from '../validators/shiftSchema.js'

const TABLE = 'shifts'

export async function getCurrentShift(cashierId: string) {
  const { data } = await db
    .from(TABLE)
    .select('*')
    .eq('cashier_id', cashierId)
    .eq('status', 'open')
    .maybeSingle()
  return data  // null якщо немає відкритої зміни
}

export async function getShift(id: string) {
  const { data, error } = await db
    .from(TABLE)
    .select('*')
    .eq('id', id)
    .single()

  if (error || !data) throw new AppError('SHIFT_NOT_FOUND', 'Зміну не знайдено', 404)
  return data
}

export async function openShift(cashierId: string, tenantId: string, input: OpenShiftInput) {
  const existing = await getCurrentShift(cashierId)
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

export async function closeShift(shiftId: string, cashierId: string, input: CloseShiftInput) {
  const shift = await getShift(shiftId)

  if (shift.cashier_id !== cashierId) {
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
    .limit(1)

  if (!reconciliations || reconciliations.length === 0) {
    throw new AppError('RECONCILIATION_REQUIRED', 'Спочатку виконайте звірку каси', 400)
  }

  // 1. Продажі — використовуємо cash_amount (правильно для cash та mixed)
  const { data: sales } = await db
    .from('sales')
    .select('cash_amount')
    .eq('shift_id', shiftId)
    .eq('status', 'completed')
  const totalCashSales = (sales ?? []).reduce((s, x) => s + (x.cash_amount ?? 0), 0)

  // 2. Повернення готівкою
  const { data: shiftSales } = await db
    .from('sales').select('id').eq('shift_id', shiftId)
  const shiftSaleIds = (shiftSales ?? []).map((s) => s.id)
  const { data: returns } = shiftSaleIds.length > 0
    ? await db.from('returns').select('refund_kopecks').eq('refund_method', 'cash').in('sale_id', shiftSaleIds)
    : { data: [] }
  const totalReturns = (returns ?? []).reduce((s, x) => s + (x.refund_kopecks ?? 0), 0)

  // 3. Cash operations (внесення/вилучення)
  const { data: cashOps } = await db
    .from('cash_operations')
    .select('type, amount')
    .eq('shift_id', shiftId)
  const cashIn  = (cashOps ?? []).filter((o) => o.type === 'in').reduce((s, x) => s + x.amount, 0)
  const cashOut = (cashOps ?? []).filter((o) => o.type === 'out').reduce((s, x) => s + x.amount, 0)

  // 4. Розрахунок expected
  const expectedCash = shift.opening_cash + totalCashSales + cashIn - totalReturns - cashOut
  const variance = input.closing_cash - expectedCash

  const { data, error } = await db
    .from(TABLE)
    .update({
      status:        'closed',
      closing_cash:  input.closing_cash,
      expected_cash: Math.max(0, expectedCash),
      cash_variance: variance,
      closed_at:     new Date().toISOString(),
      notes:         input.notes ?? shift.notes,
    })
    .eq('id', shiftId)
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

export async function getShiftReport(shiftId: string) {
  const shift = await getShift(shiftId)

  const { data: sales } = await db
    .from('sales')
    .select('id, sale_number, total, payment_method, status, completed_at')
    .eq('shift_id', shiftId)
    .order('completed_at', { ascending: true })

  const list = sales ?? []
  const completed = list.filter((s) => s.status === 'completed')

  const total_revenue = completed.reduce((s, x) => s + x.total, 0)
  const by_method = {
    cash: completed.filter((s) => s.payment_method === 'cash').reduce((s, x) => s + x.total, 0),
    card: completed.filter((s) => s.payment_method === 'card').reduce((s, x) => s + x.total, 0),
    debt: completed.filter((s) => s.payment_method === 'debt').reduce((s, x) => s + x.total, 0),
  }

  return { shift, total_sales: completed.length, total_revenue, by_method, sales: list }
}

