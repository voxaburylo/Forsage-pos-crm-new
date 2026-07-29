import { createHash, randomUUID } from 'node:crypto'
import type { LocalDatabase } from '../db/localDatabase'
import { LocalStaffRepository } from './staffRepository'
import {
  DEFAULT_TENANT_ID,
  type LocalFiscalIntentResolution,
  type LocalFiscalReturnIntentCancelInput,
  type LocalFiscalReturnIntentResolution,
  type LocalFiscalReturnIntentScope,
  type LocalFiscalSaleIntentResult,
  type LocalFiscalReturnRequest,
  type LocalFiscalSaleRequest,
  type LocalFiscalSaleIntentState,
  type LocalUnresolvedFiscalReturnIntent,
  type LocalProduct,
  type LocalSaleCheckoutInput,
  type LocalSaleCheckoutResult,
  type LocalSalePaymentInput,
} from '../db/localTypes'

function nowIso(): string {
  return new Date().toISOString()
}

function dayStamp(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

function money(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value)
}

function lineTotal(qty: number, unitPrice: number, discount = 0): number {
  return Math.max(0, money(qty * unitPrice) - money(discount))
}

function paymentMethod(payments: LocalSalePaymentInput[]): LocalSaleCheckoutResult['payment_method'] {
  const methods = Array.from(new Set(payments.map((payment) => payment.method)))
  return methods.length === 1 ? methods[0] : 'mixed'
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  )
}

function payloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex')
}

function operationId(value: unknown): string | null {
  const normalized = String(value ?? '').trim()
  if (!normalized) return null
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/.test(normalized)) {
    throw new Error('Некоректний номер операції каси')
  }
  return normalized
}

interface FiscalIntentRow {
  operation_kind: 'sale' | 'return'
  operation_id: string
  tenant_id: string
  cashier_id: string
  state: LocalFiscalSaleIntentState
  payload_hash: string
  checkout_hash: string
  checkout_json: string
  fiscal_items_json: string
  fiscal_pay_json: string
  fiscal_comment: string | null
  fiscal_result_json: string | null
  checkout_result_json: string | null
  last_error: string | null
  fiscal_number: string | null
  created_at: string
  updated_at: string
}

interface ReturnableSaleItemRow {
  id: string
  product_id: string
  product_name: string
  sku: string
  unit: string
  qty: number
  unit_price: number
  discount: number
  total: number
  core_deposit_amount: number
  already_returned_qty: number
  already_refunded_kopecks: number
}

interface RefundPoolAllocation {
  productRefundPool: number
  lineRefunds: Map<string, number>
}

function allocateRefundPool(
  saleTotal: number,
  items: ReturnableSaleItemRow[],
): RefundPoolAllocation {
  if (!Number.isFinite(saleTotal) || saleTotal < 0) {
    throw new Error('У чеку вказано некоректну суму')
  }

  const weighted = items.map((item) => {
    const qty = Number(item.qty)
    const unitPrice = Number(item.unit_price)
    const discount = Number(item.discount ?? 0)
    const coreDeposit = Number(item.core_deposit_amount ?? 0)
    if (
      !Number.isFinite(qty)
      || qty <= 0
      || !Number.isFinite(unitPrice)
      || unitPrice < 0
      || !Number.isFinite(discount)
      || discount < 0
      || !Number.isFinite(coreDeposit)
      || coreDeposit < 0
    ) {
      throw new Error('У чеку є некоректна позиція')
    }
    return {
      id: item.id,
      weight: Math.max(0, (unitPrice * qty) - discount),
      coreTotal: Math.max(0, coreDeposit * qty),
    }
  })

  const lineNetTotal = weighted.reduce((sum, item) => sum + item.weight, 0)
  const coreTotal = weighted.reduce((sum, item) => sum + item.coreTotal, 0)
  const productRefundPool = Math.min(
    money(lineNetTotal),
    Math.max(0, money(saleTotal) - money(coreTotal)),
  )
  const lineRefunds = new Map<string, number>()
  if (productRefundPool <= 0 || lineNetTotal <= 0) {
    for (const item of weighted) lineRefunds.set(item.id, 0)
    return { productRefundPool, lineRefunds }
  }

  const allocations = weighted.map((item) => {
    const raw = (item.weight * productRefundPool) / lineNetTotal
    const base = Math.floor(raw)
    return { id: item.id, base, fraction: raw - base }
  })
  let remainder = productRefundPool - allocations.reduce((sum, item) => sum + item.base, 0)
  const ranked = [...allocations].sort(
    (left, right) => right.fraction - left.fraction || left.id.localeCompare(right.id),
  )
  for (const item of ranked) {
    const extra = remainder > 0 ? 1 : 0
    lineRefunds.set(item.id, item.base + extra)
    remainder -= extra
  }
  return { productRefundPool, lineRefunds }
}

export class LocalPosRepository {
  constructor(private readonly db: LocalDatabase) {
    this.markInterruptedFiscalIntentsUnknown()
  }

  prepareFiscalSaleIntent(request: LocalFiscalSaleRequest): LocalFiscalSaleIntentResult {
    const id = operationId(request.operation_id)
    if (!id) throw new Error('Для фіскального чека потрібен номер операції')
    const checkoutOperationId = operationId(request.checkout.client_operation_id)
    if (checkoutOperationId && checkoutOperationId !== id) {
      throw new Error('FISCAL_INTENT_CONFLICT|Номер операції не відповідає чеку')
    }
    if (!Array.isArray(request.items) || request.items.length === 0) {
      throw new Error('Фіскальний чек не містить товарів')
    }

    const checkout: LocalSaleCheckoutInput = {
      ...request.checkout,
      client_operation_id: id,
      is_fiscal: true,
    }
    const tenantId = checkout.tenant_id ?? DEFAULT_TENANT_ID
    const checkoutHash = this.checkoutPayloadHash(checkout, tenantId)
    const hash = payloadHash({
      checkout: this.checkoutIdentity(checkout, tenantId),
      items: request.items,
      pay: request.pay,
      comment: request.comment ?? null,
    })
    const existing = this.getFiscalIntentRow(id)
    if (existing) {
      if (existing.payload_hash !== hash || existing.checkout_hash !== checkoutHash) {
        throw new Error('FISCAL_INTENT_CONFLICT|Цей номер операції вже використано для іншого чека')
      }
      return this.fiscalIntentResult(existing)
    }
    const ready = this.assertCheckoutReady(checkout)
    const fiscalTotal = money(request.pay.check_total)
    const fiscalPayments = money(request.pay.cash) + money(request.pay.card) + money(request.pay.bank ?? 0)
    const fiscalItemsTotal = request.items.reduce((sum, item) => sum + money(item.amount), 0)
    if (fiscalTotal !== ready.total || fiscalPayments !== fiscalTotal || fiscalItemsTotal !== fiscalTotal) {
      throw new Error('Сума фіскального чека не відповідає сумі продажу')
    }

    const timestamp = nowIso()
    this.db.prepare(`
      INSERT INTO fiscal_sale_intents (
        operation_id, tenant_id, cashier_id, payload_hash, checkout_hash,
        checkout_json, fiscal_items_json, fiscal_pay_json, fiscal_comment,
        state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)
    `).run(
      id,
      tenantId,
      checkout.cashier_id,
      hash,
      checkoutHash,
      JSON.stringify(checkout),
      JSON.stringify(request.items),
      JSON.stringify(request.pay),
      request.comment ?? null,
      timestamp,
      timestamp,
    )
    return this.fiscalIntentResult(this.requireFiscalIntentRow(id))
  }

  prepareFiscalReturnIntent(request: LocalFiscalReturnRequest): LocalFiscalSaleIntentResult {
    const id = operationId(request.operation_id)
    if (!id) throw new Error('Для фіскального повернення потрібен номер операції')
    const input: Record<string, any> = {
      ...request.return_input,
      client_operation_id: id,
      is_fiscal: true,
    }
    const inputOperationId = operationId(input.client_operation_id)
    if (inputOperationId !== id) {
      throw new Error('FISCAL_INTENT_CONFLICT|Номер операції не відповідає поверненню')
    }

    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const returnHash = this.returnPayloadHash(input, tenantId)
    const hash = payloadHash({
      return: this.returnIdentity(input, tenantId),
      items: request.items,
      pay: request.pay,
      original_fiscal_number: request.original_fiscal_number,
    })
    const existing = this.getFiscalIntentRow(id)
    if (existing) {
      if (
        existing.operation_kind !== 'return'
        || existing.payload_hash !== hash
        || existing.checkout_hash !== returnHash
      ) {
        throw new Error('FISCAL_INTENT_CONFLICT|Цей номер операції вже використано для іншого повернення')
      }
      return this.fiscalIntentResult(existing)
    }
    const saleId = String(input.sale_id ?? '').trim()
    if (saleId) {
      const unresolved = (this.db.prepare(`
        SELECT operation_id, checkout_json
        FROM fiscal_sale_intents
        WHERE tenant_id = ?
          AND operation_kind = 'return'
          AND operation_id <> ?
          AND state IN ('prepared', 'fiscalizing', 'unknown', 'fiscalized')
      `).all(tenantId, id) as Array<{ operation_id: string; checkout_json: string }>).find((row) => {
        try {
          const pendingInput = JSON.parse(row.checkout_json) as Record<string, unknown>
          return String(pendingInput.sale_id ?? '').trim() === saleId
        } catch {
          return false
        }
      })
      if (unresolved) {
        throw new Error(
          'FISCAL_RETURN_PENDING|Для цього чека вже є незавершене фіскальне повернення. Завершіть його або перевірте результат у Cashalot.',
        )
      }
    }
    const ready = this.assertReturnReady(input)
    if (!ready.sale.fiscal_number || ready.sale.fiscal_number !== request.original_fiscal_number) {
      throw new Error('FISCAL_INTENT_CONFLICT|Фіскальний номер оригінального чека не збігається')
    }
    const fiscalTotal = money(request.pay.check_total)
    const fiscalPayments = money(request.pay.cash) + money(request.pay.card) + money(request.pay.bank ?? 0)
    const fiscalItemsTotal = request.items.reduce((sum, item) => sum + money(item.amount), 0)
    if (fiscalTotal !== ready.refund || fiscalPayments !== fiscalTotal || fiscalItemsTotal !== fiscalTotal) {
      throw new Error('Сума фіскального повернення не відповідає вибраним товарам')
    }

    const timestamp = nowIso()
    this.db.prepare(`
      INSERT INTO fiscal_sale_intents (
        operation_id, tenant_id, cashier_id, payload_hash, checkout_hash,
        checkout_json, fiscal_items_json, fiscal_pay_json, fiscal_comment,
        state, operation_kind, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 'return', ?, ?)
    `).run(
      id,
      ready.tenant_id,
      ready.approved_by,
      hash,
      returnHash,
      JSON.stringify(input),
      JSON.stringify(request.items),
      JSON.stringify(request.pay),
      request.original_fiscal_number,
      timestamp,
      timestamp,
    )
    return this.fiscalIntentResult(this.requireFiscalIntentRow(id))
  }

  startFiscalSaleIntent(idValue: string): LocalFiscalSaleIntentResult {
    const id = operationId(idValue)
    if (!id) throw new Error('Номер операції каси не вказано')
    const timestamp = nowIso()
    const update = this.db.prepare(`
      UPDATE fiscal_sale_intents
      SET state = 'fiscalizing', fiscal_started_at = ?, last_error = NULL, updated_at = ?
      WHERE operation_id = ? AND state = 'prepared'
    `).run(timestamp, timestamp, id) as { changes: number | bigint }
    if (Number(update.changes) === 0) {
      const current = this.requireFiscalIntentRow(id)
      if (current.state === 'fiscalizing' || current.state === 'unknown') {
        throw new Error(`FISCAL_INTENT_UNKNOWN|${id}|Стан фіскального чека невідомий`)
      }
      return this.fiscalIntentResult(current)
    }
    return this.fiscalIntentResult(this.requireFiscalIntentRow(id))
  }

  markFiscalSaleIntentFiscalized(
    idValue: string,
    result: Record<string, unknown>,
  ): LocalFiscalSaleIntentResult {
    const id = operationId(idValue)
    if (!id) throw new Error('Номер операції каси не вказано')
    const timestamp = nowIso()
    const fiscalNumber = String(result.ReceiptFiscalNum ?? result.ReceiptLocalNum ?? '').trim() || null
    const fiscalQrUrl = String(result.FSKOReceiptLink ?? result.CashalotReceiptLink ?? '').trim() || null
    const update = this.db.prepare(`
      UPDATE fiscal_sale_intents
      SET state = 'fiscalized', fiscal_result_json = ?, fiscal_number = ?,
          fiscal_qr_url = ?, fiscalized_at = ?, last_error = NULL, updated_at = ?
      WHERE operation_id = ? AND state = 'fiscalizing'
    `).run(JSON.stringify(result), fiscalNumber, fiscalQrUrl, timestamp, timestamp, id) as { changes: number | bigint }
    if (Number(update.changes) === 0) {
      const current = this.requireFiscalIntentRow(id)
      if (current.state !== 'fiscalized' && current.state !== 'completed') {
        throw new Error(`FISCAL_INTENT_UNKNOWN|${id}|Не вдалося надійно зберегти фіскальний чек`)
      }
    }
    return this.fiscalIntentResult(this.requireFiscalIntentRow(id))
  }

  markFiscalSaleIntentUnknown(idValue: string, error: string): LocalFiscalSaleIntentResult {
    const id = operationId(idValue)
    if (!id) throw new Error('Номер операції каси не вказано')
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE fiscal_sale_intents
      SET state = 'unknown', last_error = ?, updated_at = ?
      WHERE operation_id = ? AND state = 'fiscalizing'
    `).run(String(error || 'Невідома помилка ПРРО').slice(0, 1000), timestamp, id)
    return this.fiscalIntentResult(this.requireFiscalIntentRow(id))
  }

  resolveUnknownFiscalSaleIntent(
    idValue: string,
    resolution: LocalFiscalIntentResolution,
  ): LocalFiscalSaleIntentResult {
    const id = operationId(idValue)
    if (!id) throw new Error('Номер операції каси не вказано')
    const confirmedBy = String(resolution.confirmed_by ?? '').trim()
    const reason = String(resolution.reason ?? '').trim()
    if (resolution.cashalot_checked !== true || !confirmedBy || reason.length < 10) {
      throw new Error('Підтвердьте перевірку Cashalot, відповідального та причину')
    }
    const timestamp = nowIso()
    const update = this.db.prepare(`
      UPDATE fiscal_sale_intents
      SET state = 'prepared', fiscal_result_json = NULL, fiscal_number = NULL,
          fiscal_qr_url = NULL, fiscal_started_at = NULL, fiscalized_at = NULL,
          manual_reset_count = manual_reset_count + 1, resolved_by = ?,
          resolved_reason = ?, resolved_at = ?, updated_at = ?
      WHERE operation_id = ? AND state IN ('fiscalizing', 'unknown')
    `).run(confirmedBy, reason, timestamp, timestamp, id) as { changes: number | bigint }
    if (Number(update.changes) === 0) {
      throw new Error('Цей чек не можна розблокувати: він уже завершений або не був запущений')
    }
    const intent = this.requireFiscalIntentRow(id)
    this.addAudit(
      intent.tenant_id,
      confirmedBy,
      intent.operation_kind === 'return'
        ? 'fiscal_return_intent.manually_reset'
        : 'fiscal_sale_intent.manually_reset',
      'fiscal_sale_intent',
      id,
      { reason, checked_at: timestamp },
      timestamp,
    )
    return this.fiscalIntentResult(intent)
  }

  getFiscalSaleIntent(idValue: string): LocalFiscalSaleIntentResult {
    const id = operationId(idValue)
    if (!id) throw new Error('Номер операції каси не вказано')
    return this.fiscalIntentResult(this.requireFiscalIntentRow(id))
  }

  listUnresolvedFiscalReturnIntents(
    scope: LocalFiscalReturnIntentScope,
  ): LocalUnresolvedFiscalReturnIntent[] {
    const tenantId = scope.tenant_id ?? DEFAULT_TENANT_ID
    const cashierId = String(scope.cashier_id ?? '').trim()
    if (!cashierId) throw new Error('Не вказано касира для пошуку незавершених повернень')

    const rows = this.db.prepare(`
      SELECT operation_kind, operation_id, tenant_id, cashier_id, state,
             payload_hash, checkout_hash, checkout_json, fiscal_items_json,
             fiscal_pay_json, fiscal_comment, fiscal_result_json,
             checkout_result_json, last_error, fiscal_number, created_at, updated_at
      FROM fiscal_sale_intents
      WHERE tenant_id = ? AND cashier_id = ? AND operation_kind = 'return'
        AND state IN ('prepared', 'fiscalizing', 'unknown', 'fiscalized')
      ORDER BY created_at ASC
    `).all(tenantId, cashierId) as unknown as FiscalIntentRow[]

    return rows.map((row) => {
      const returnInput = this.parseFiscalIntentJson<Record<string, any>>(
        row.checkout_json,
        'Дані незавершеного повернення пошкоджені',
      )
      const fiscalPay = this.parseFiscalIntentJson<Record<string, any>>(
        row.fiscal_pay_json,
        'Сума незавершеного повернення пошкоджена',
      )
      const saleId = String(returnInput.sale_id ?? '').trim() || null
      const sale = saleId
        ? this.db.prepare(`
            SELECT sale_number
            FROM sales
            WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
            LIMIT 1
          `).get(saleId, tenantId) as { sale_number: string } | undefined
        : undefined
      const items = Array.isArray(returnInput.items) ? returnInput.items : []
      return {
        operation_id: row.operation_id,
        tenant_id: row.tenant_id,
        cashier_id: row.cashier_id,
        state: row.state as Exclude<LocalFiscalSaleIntentState, 'completed'>,
        sale_id: saleId,
        sale_number: sale?.sale_number ?? null,
        refund_kopecks: money(Number(fiscalPay.check_total ?? 0)),
        refund_method: String(returnInput.refund_method ?? 'cash'),
        item_count: items.length,
        fiscal_number: row.fiscal_number ?? null,
        last_error: row.last_error ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        can_cancel: row.state === 'prepared',
      }
    })
  }

  getFiscalReturnRequest(
    idValue: string,
    scope: LocalFiscalReturnIntentScope,
  ): LocalFiscalReturnRequest {
    const intent = this.requireScopedFiscalReturnIntent(idValue, scope)
    const returnInput = this.parseFiscalIntentJson<Record<string, unknown>>(
      intent.checkout_json,
      'Дані незавершеного повернення пошкоджені',
    )
    const items = this.parseFiscalIntentJson<LocalFiscalReturnRequest['items']>(
      intent.fiscal_items_json,
      'Товари незавершеного повернення пошкоджені',
    )
    const pay = this.parseFiscalIntentJson<LocalFiscalReturnRequest['pay']>(
      intent.fiscal_pay_json,
      'Оплата незавершеного повернення пошкоджена',
    )
    const originalFiscalNumber = String(intent.fiscal_comment ?? '').trim()
    if (!Array.isArray(items) || !originalFiscalNumber) {
      throw new Error('Дані незавершеного повернення неповні')
    }
    return {
      operation_id: intent.operation_id,
      return_input: returnInput,
      items,
      pay,
      original_fiscal_number: originalFiscalNumber,
    }
  }

  resolveUnknownFiscalReturnIntent(
    idValue: string,
    resolution: LocalFiscalReturnIntentResolution,
  ): LocalFiscalSaleIntentResult {
    this.requireScopedFiscalReturnIntent(idValue, resolution)
    if (String(resolution.confirmed_by ?? '').trim() !== String(resolution.cashier_id ?? '').trim()) {
      throw new Error('Повернення може розблокувати лише касир, який його створив')
    }
    return this.resolveUnknownFiscalSaleIntent(idValue, resolution)
  }

  cancelPreparedFiscalReturnIntent(
    idValue: string,
    input: LocalFiscalReturnIntentCancelInput,
  ): { operation_id: string; cancelled: true } {
    const id = operationId(idValue)
    if (!id) throw new Error('Номер операції каси не вказано')
    const cashierId = String(input.cashier_id ?? '').trim()
    const confirmedBy = String(input.confirmed_by ?? '').trim()
    const reason = String(input.reason ?? '').trim()
    if (!cashierId || !confirmedBy || confirmedBy !== cashierId || reason.length < 10) {
      throw new Error('Скасування має підтвердити касир із зазначенням причини')
    }
    const timestamp = nowIso()
    return this.db.transaction(() => {
      const intent = this.requireScopedFiscalReturnIntent(id, input)
      if (intent.state !== 'prepared') {
        throw new Error(
          'Це повернення вже передавалося у Cashalot. Спочатку перевірте результат, скасування заборонено',
        )
      }
      const deleted = this.db.prepare(`
        DELETE FROM fiscal_sale_intents
        WHERE operation_id = ? AND tenant_id = ? AND cashier_id = ?
          AND operation_kind = 'return' AND state = 'prepared'
      `).run(id, intent.tenant_id, intent.cashier_id) as { changes: number | bigint }
      if (Number(deleted.changes) !== 1) {
        throw new Error('Стан повернення змінився. Оновіть список і перевірте Cashalot')
      }
      this.addAudit(
        intent.tenant_id,
        confirmedBy,
        'fiscal_return_intent.cancelled',
        'fiscal_return_intent',
        id,
        { reason, cancelled_at: timestamp },
        timestamp,
      )
      return { operation_id: id, cancelled: true as const }
    })
  }

  openShift(input: {
    tenant_id?: string
    cashier_id: string
    opening_cash?: number
    notes?: string | null
  }): string {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const existing = this.findOpenShift(input.cashier_id, tenantId)
    if (existing) return existing

    const timestamp = nowIso()
    const shiftId = randomUUID()
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO shifts (
          id, tenant_id, cashier_id, status, opening_cash, opened_at,
          notes, dirty_at, created_at, updated_at
        )
        VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)
      `).run(
        shiftId,
        tenantId,
        input.cashier_id,
        input.opening_cash ?? 0,
        timestamp,
        input.notes ?? null,
        timestamp,
        timestamp,
        timestamp,
      )

      this.addOutbox(
        tenantId,
        'shift',
        shiftId,
        'shift.opened',
        { id: shiftId, cashier_id: input.cashier_id, opening_cash: input.opening_cash ?? 0 },
        timestamp,
      )
    })

    return shiftId
  }

  findOpenShift(cashierId: string, tenantId = DEFAULT_TENANT_ID): string | null {
    return this.getOpenShift(cashierId, tenantId)?.id ?? null
  }

  getOpenShift(cashierId: string, tenantId = DEFAULT_TENANT_ID): {
    id: string
    cashier_id: string
    status: 'open'
    opening_cash: number
    closing_cash: number | null
    expected_cash: number | null
    cash_variance: number | null
    opened_at: string
    closed_at: string | null
    notes: string | null
  } | null {
    const row = this.db.prepare(`
      SELECT id, cashier_id, status, opening_cash, closing_cash, expected_cash,
             cash_variance, opened_at, closed_at, notes
      FROM shifts
      WHERE tenant_id = ?
        AND cashier_id = ?
        AND status = 'open'
        AND deleted_at IS NULL
      ORDER BY opened_at DESC
      LIMIT 1
    `).get(tenantId, cashierId) as {
      id: string
      cashier_id: string
      status: 'open'
      opening_cash: number
      closing_cash: number | null
      expected_cash: number | null
      cash_variance: number | null
      opened_at: string
      closed_at: string | null
      notes: string | null
    } | undefined
    return row ?? null
  }

  // Список боржників з локальної бази (клієнти з боргом > 0), для каси офлайн.
  listDebtors(tenantId = DEFAULT_TENANT_ID, limit = 200): Array<{
    id: string
    full_name: string | null
    phone: string | null
    debt_balance: number
    deposit_balance: number
  }> {
    return this.db.prepare(`
      SELECT id, full_name, phone, debt_balance, COALESCE(deposit_balance, 0) AS deposit_balance
      FROM customers
      WHERE tenant_id = ? AND deleted_at IS NULL AND debt_balance > 0
      ORDER BY debt_balance DESC
      LIMIT ?
    `).all(tenantId, limit) as unknown as Array<{
      id: string; full_name: string | null; phone: string | null; debt_balance: number; deposit_balance: number
    }>
  }

  searchCustomers(input: { tenant_id?: string; search?: string; has_debt?: boolean; limit?: number } = {}): Array<{
    id: string
    full_name: string | null
    phone: string | null
    debt_balance: number
    deposit_balance: number
  }> {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const limit = Math.max(1, Math.min(200, input.limit ?? 50))
    const rawSearch = String(input.search ?? '').trim()
    const search = rawSearch.toLocaleLowerCase('uk-UA')
    const titleSearch = search.replace(/(^|\s)\S/g, (char) => char.toLocaleUpperCase('uk-UA'))
    const upperSearch = search.toLocaleUpperCase('uk-UA')
    const digits = search.replace(/\D/g, '')
    const params: any[] = [tenantId]
    let where = 'tenant_id = ? AND deleted_at IS NULL'
    if (input.has_debt) where += ' AND debt_balance > 0'
    if (search) {
      where += ` AND (
        lower(COALESCE(full_name, '')) LIKE ?
        OR COALESCE(phone, '') LIKE ?
        OR lower(COALESCE(email, '')) LIKE ?
        OR lower(COALESCE(card_barcode, '')) LIKE ?
      )`
      const q = `%${search}%`
      params.push(q, `%${digits || search}%`, q, q)
    }
    params.push(limit)
    return this.db.prepare(`
      SELECT id, full_name, phone, debt_balance, COALESCE(deposit_balance, 0) AS deposit_balance
      FROM customers
      WHERE ${where}
      ORDER BY ${input.has_debt ? 'debt_balance DESC,' : ''} updated_at DESC
      LIMIT ?
    `).all(...params) as unknown as Array<{
      id: string; full_name: string | null; phone: string | null; debt_balance: number; deposit_balance: number
    }>
  }

  listCustomers(input: {
    tenant_id?: string
    search?: string
    has_debt?: string
    tag?: string
    sort?: string
    page?: number
    per_page?: number
  } = {}): { data: any[]; pagination: { page: number; per_page: number; total: number; total_pages: number } } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const page = Math.max(1, Number(input.page ?? 1) || 1)
    const perPage = Math.max(1, Math.min(200, Number(input.per_page ?? 50) || 50))
    const offset = (page - 1) * perPage
    const rawSearch = String(input.search ?? '').trim()
    const search = rawSearch.toLocaleLowerCase('uk-UA')
    const titleSearch = search.replace(/(^|\s)\S/g, (char) => char.toLocaleUpperCase('uk-UA'))
    const upperSearch = search.toLocaleUpperCase('uk-UA')
    const digits = search.replace(/\D/g, '')
    const where = ['c.tenant_id = ?', 'c.deleted_at IS NULL']
    const params: any[] = [tenantId]
    if (input.has_debt === 'true') where.push('c.debt_balance > 0')
    if (input.tag) {
      where.push('c.tags_json LIKE ?')
      params.push(`%"${input.tag}"%`)
    }
    if (search) {
      where.push(`(
        COALESCE(c.full_name, '') LIKE ?
        OR COALESCE(c.full_name, '') LIKE ?
        OR COALESCE(c.full_name, '') LIKE ?
        OR lower(COALESCE(c.email, '')) LIKE ?
        OR COALESCE(c.phone, '') LIKE ?
        OR lower(COALESCE(c.card_barcode, '')) LIKE ?
        OR EXISTS (
          SELECT 1 FROM customer_vehicles v
          WHERE v.customer_id = c.id AND v.tenant_id = c.tenant_id
            AND v.deleted_at IS NULL
            AND lower(COALESCE(v.vin, '')) LIKE ?
        )
      )`)
      const q = `%${search}%`
      params.push(`%${rawSearch}%`, `%${titleSearch}%`, `%${upperSearch}%`, q, `%${digits || search}%`, q, q)
    }
    const whereSql = where.join(' AND ')
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS total FROM customers c WHERE ${whereSql}`)
      .get(...params) as { total: number }
    const orderBy = input.sort === 'debt'
      ? 'c.debt_balance DESC, c.updated_at DESC'
      : input.sort === 'name'
        ? 'lower(COALESCE(c.full_name, c.phone, c.id)) ASC'
        : 'c.updated_at DESC'
    const rows = this.db.prepare(`
      SELECT c.*,
        (SELECT v.vin FROM customer_vehicles v
         WHERE v.customer_id = c.id AND v.tenant_id = c.tenant_id AND v.deleted_at IS NULL
         ORDER BY v.created_at ASC LIMIT 1) AS primary_vin,
        (SELECT COUNT(*) FROM customer_vehicles v
         WHERE v.customer_id = c.id AND v.tenant_id = c.tenant_id AND v.deleted_at IS NULL) AS car_count
      FROM customers c
      WHERE ${whereSql}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...params, perPage, offset) as any[]
    const total = Number(totalRow?.total ?? 0)
    return {
      data: rows.map((row) => this.decorateCustomer(row)),
      pagination: { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) },
    }
  }

  getCustomer(customerId: string, tenantId = DEFAULT_TENANT_ID): any {
    const row = this.db.prepare(`
      SELECT c.*,
        (SELECT v.vin FROM customer_vehicles v
         WHERE v.customer_id = c.id AND v.tenant_id = c.tenant_id AND v.deleted_at IS NULL
         ORDER BY v.created_at ASC LIMIT 1) AS primary_vin,
        (SELECT COUNT(*) FROM customer_vehicles v
         WHERE v.customer_id = c.id AND v.tenant_id = c.tenant_id AND v.deleted_at IS NULL) AS car_count
      FROM customers c
      WHERE c.id = ? AND c.tenant_id = ? AND c.deleted_at IS NULL
      LIMIT 1
    `).get(customerId, tenantId) as any
    if (!row) throw new Error('Клієнта не знайдено')
    return this.decorateCustomer(row)
  }

  getCustomerSales(customerId: string, tenantId = DEFAULT_TENANT_ID): any[] {
    return this.db.prepare(`
      SELECT id, sale_number, total, payment_method, status, completed_at
      FROM sales
      WHERE customer_id = ? AND tenant_id = ? AND deleted_at IS NULL
      ORDER BY completed_at DESC
      LIMIT 200
    `).all(customerId, tenantId) as any[]
  }

  saveCustomer(input: any, customerId?: string): { data: any; meta?: { reused: boolean; vehicle_added: boolean } } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const timestamp = nowIso()
    const phone = String(input.phone ?? '').trim()
    if (!customerId && !phone) throw new Error("Телефон обов'язковий")

    if (!customerId) {
      const existing = this.db.prepare(`
        SELECT id FROM customers
        WHERE tenant_id = ? AND deleted_at IS NULL AND phone = ?
        LIMIT 1
      `).get(tenantId, phone) as { id: string } | undefined
      if (existing) {
        const vehicleAdded = this.addCustomerVehicle(existing.id, tenantId, input.vehicle, timestamp)
        return { data: this.getCustomer(existing.id, tenantId), meta: { reused: true, vehicle_added: vehicleAdded } }
      }
    }

    const id = customerId ?? randomUUID()
    if (customerId) {
      const current = this.getCustomer(customerId, tenantId)
      const requestedBonus = input.bonus_balance !== undefined ? money(input.bonus_balance) : null
      if (requestedBonus !== null && requestedBonus < 0) throw new Error('Баланс бонусів не може бути від’ємним')
      const values: Record<string, any> = {
        phone: input.phone,
        full_name: input.full_name,
        email: input.email,
        birth_date: input.birth_date,
        notes: input.notes,
        tags_json: input.tags !== undefined ? JSON.stringify(input.tags ?? []) : undefined,
        price_tier_id: input.price_tier_id,
        vip_level: input.vip_level,
        risk_profile: input.risk_profile,
        discount_pct: input.discount_pct,
        loyalty_mode: input.loyalty_mode === 'cashback' ? 'cashback' : input.loyalty_mode === 'discount' ? 'discount' : undefined,
        client_status: input.client_status,
        card_barcode: input.card_barcode,
      }
      const entries = Object.entries(values).filter(([, value]) => value !== undefined)
      return this.db.transaction(() => {
        if (entries.length) {
          const sets = entries.map(([key]) => `${key} = ?`)
          this.db.prepare(`
            UPDATE customers
            SET ${sets.join(', ')}, dirty_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
          `).run(...entries.map(([, value]) => value), timestamp, timestamp, id, tenantId)
          const syncPatch = Object.fromEntries(entries.map(([key, value]) => [
            key === 'tags_json' ? 'tags' : key,
            key === 'tags_json' ? JSON.parse(String(value)) : value,
          ]))
          this.addOutbox(tenantId, 'customer', id, 'customer.updated', { id, ...syncPatch, updated_at: timestamp }, timestamp)
        }
        if (requestedBonus !== null && requestedBonus !== Number(current.bonus_balance ?? 0)) {
          const bonusAmount = requestedBonus - Number(current.bonus_balance ?? 0)
          const transactionId = randomUUID()
          const description = bonusAmount > 0 ? 'Ручне нарахування' : 'Ручне списання'
          this.db.prepare(`
            UPDATE customers
            SET bonus_balance = ?, dirty_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
          `).run(requestedBonus, timestamp, timestamp, id, tenantId)
          this.db.prepare(`
            INSERT INTO bonus_transactions (
              id, tenant_id, customer_id, amount, transaction_type, description,
              created_by, dirty_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?)
          `).run(
            transactionId, tenantId, id, bonusAmount, description,
            input.user_id ?? null, timestamp, timestamp, timestamp,
          )
          this.addOutbox(tenantId, 'customer', id, 'customer.bonus_adjusted', {
            customer_id: id,
            transaction_id: transactionId,
            amount: bonusAmount,
            description,
            created_by: input.user_id ?? null,
            created_at: timestamp,
          }, timestamp)
        }
        return { data: this.getCustomer(id, tenantId) }
      })
    }
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO customers (
          id, tenant_id, phone, full_name, email, birth_date, debt_balance, notes, tags_json,
          price_tier_id, bonus_balance, vip_level, risk_profile, discount_pct,
          client_status, card_barcode, dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, 'standard', 'low', ?, ?, ?, ?, ?, ?)
      `).run(
        id, tenantId, phone, input.full_name ?? null, input.email ?? null, input.birth_date ?? null,
        input.notes ?? null, JSON.stringify(input.tags ?? []), input.price_tier_id ?? null,
        Number(input.discount_pct ?? 0), input.client_status ?? 'client',
        input.card_barcode ?? null, timestamp, timestamp, timestamp,
      )
      this.addOutbox(tenantId, 'customer', id, 'customer.created', {
        id, phone, full_name: input.full_name ?? null, email: input.email ?? null, birth_date: input.birth_date ?? null,
        notes: input.notes ?? null, tags: input.tags ?? [], price_tier_id: input.price_tier_id ?? null,
        discount_pct: Number(input.discount_pct ?? 0), client_status: input.client_status ?? 'client',
        card_barcode: input.card_barcode ?? null, vehicle: input.vehicle ?? null,
      }, timestamp)
      this.addCustomerVehicle(id, tenantId, input.vehicle, timestamp)
    })
    return { data: this.getCustomer(id, tenantId), meta: { reused: false, vehicle_added: Boolean(input.vehicle) } }
  }

  deleteCustomer(customerId: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    const timestamp = nowIso()
    const customer = this.getCustomerForMoney(customerId, tenantId)
    if (Number(customer.debt_balance ?? 0) !== 0 || Number(customer.deposit_balance ?? 0) !== 0 || Number((customer as any).bonus_balance ?? 0) !== 0) {
      throw new Error('Клієнта не можна видалити, доки є борг, передплата або бонуси')
    }
    const activeOrder = this.db.prepare(`
      SELECT id FROM customer_orders
      WHERE customer_id = ? AND tenant_id = ? AND deleted_at IS NULL
        AND status NOT IN ('completed', 'cancelled', 'canceled', 'archived')
      LIMIT 1
    `).get(customerId, tenantId)
    if (activeOrder) throw new Error('У клієнта є незавершені замовлення або чернетки')
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE customers SET deleted_at = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(timestamp, timestamp, timestamp, customerId, tenantId)
      this.db.prepare(`
        UPDATE customer_vehicles SET deleted_at = ?, dirty_at = ?, updated_at = ?
        WHERE customer_id = ? AND tenant_id = ? AND deleted_at IS NULL
      `).run(timestamp, timestamp, timestamp, customerId, tenantId)
      this.addOutbox(tenantId, 'customer', customerId, 'customer.deleted', { id: customerId }, timestamp)
    })
    return { ok: true }
  }
  listCustomerVehicles(customerId: string, tenantId = DEFAULT_TENANT_ID): any[] {
    this.getCustomer(customerId, tenantId)
    return this.db.prepare(`
      SELECT id, customer_id, brand, model, year, vin, notes, created_at, updated_at
      FROM customer_vehicles
      WHERE customer_id = ? AND tenant_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC
    `).all(customerId, tenantId) as any[]
  }

  saveCustomerVehicle(customerId: string, input: any, vehicleId?: string): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    this.getCustomer(customerId, tenantId)
    const timestamp = nowIso()
    const id = vehicleId ?? randomUUID()
    const existing = vehicleId
      ? this.db.prepare(`
          SELECT * FROM customer_vehicles
          WHERE id = ? AND customer_id = ? AND tenant_id = ? AND deleted_at IS NULL
        `).get(vehicleId, customerId, tenantId) as any
      : null
    if (vehicleId && !existing) throw new Error('Автомобіль не знайдено')
    const brand = String(input.brand ?? input.make ?? existing?.brand ?? '').trim()
    const model = String(input.model ?? existing?.model ?? '').trim()
    if (!brand && !model && !String(input.vin ?? existing?.vin ?? '').trim()) {
      throw new Error('Вкажіть марку, модель або VIN')
    }
    const next = {
      brand,
      model,
      year: input.year !== undefined && input.year !== null && input.year !== '' ? Number(input.year) : existing?.year ?? null,
      vin: String(input.vin ?? existing?.vin ?? '').trim().toUpperCase() || null,
      notes: input.notes !== undefined ? (String(input.notes ?? '').trim() || null) : existing?.notes ?? null,
    }
    this.db.prepare(`
      INSERT INTO customer_vehicles (
        id, tenant_id, customer_id, brand, model, year, vin, notes,
        dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        brand = excluded.brand, model = excluded.model, year = excluded.year,
        vin = excluded.vin, notes = excluded.notes, dirty_at = excluded.dirty_at,
        updated_at = excluded.updated_at, deleted_at = NULL
    `).run(
      id, tenantId, customerId, next.brand, next.model, next.year, next.vin, next.notes,
      timestamp, existing?.created_at ?? timestamp, timestamp,
    )
    this.addOutbox(tenantId, 'customer_vehicle', id, vehicleId ? 'customer_vehicle.updated' : 'customer_vehicle.created', {
      id, customer_id: customerId, ...next,
    }, timestamp)
    return this.db.prepare(`
      SELECT id, customer_id, brand, model, year, vin, notes, created_at, updated_at
      FROM customer_vehicles WHERE id = ? AND tenant_id = ?
    `).get(id, tenantId)
  }

  deleteCustomerVehicle(customerId: string, vehicleId: string, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    const timestamp = nowIso()
    const result = this.db.prepare(`
      UPDATE customer_vehicles SET deleted_at = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND customer_id = ? AND tenant_id = ? AND deleted_at IS NULL
    `).run(timestamp, timestamp, timestamp, vehicleId, customerId, tenantId)
    if (Number(result.changes) === 0) throw new Error('Автомобіль не знайдено')
    this.addOutbox(tenantId, 'customer_vehicle', vehicleId, 'customer_vehicle.deleted', {
      id: vehicleId, customer_id: customerId,
    }, timestamp)
    return { ok: true }
  }
  getCustomerDeposit(customerId: string, tenantId = DEFAULT_TENANT_ID): {
    balance: number
    transactions: any[]
  } {
    const customer = this.db.prepare(`
      SELECT id, COALESCE(deposit_balance, 0) AS deposit_balance
      FROM customers
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(customerId, tenantId) as { id: string; deposit_balance: number } | undefined
    if (!customer) throw new Error('Клієнта не знайдено')
    const transactions = this.db.prepare(`
      SELECT id, amount, balance_after, method, order_id, sale_id, shift_id, notes, created_at
      FROM customer_deposit_transactions
      WHERE tenant_id = ? AND customer_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 50
    `).all(tenantId, customerId)
    return { balance: Number(customer.deposit_balance ?? 0), transactions }
  }

  payDebt(input: {
    tenant_id?: string
    customer_id: string
    amount: number
    method: 'cash' | 'card' | 'transfer'
    shift_id?: string | null
    user_id?: string | null
    notes?: string | null
  }): { data: any } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const amount = money(input.amount)
    if (amount <= 0) throw new Error('Вкажіть коректну суму')
    if (input.method === 'cash' && !input.shift_id) {
      throw new Error('Для оплати готівкою потрібна відкрита касова зміна')
    }
    return this.db.transaction(() => {
      const customer = this.getCustomerForMoney(input.customer_id, tenantId)
      if (customer.debt_balance <= 0) throw new Error('У клієнта немає боргу')
      if (amount > customer.debt_balance) throw new Error('Сума перевищує борг клієнта')
      const timestamp = nowIso()
      const balanceAfter = customer.debt_balance - amount
      this.db.prepare(`
        UPDATE customers
        SET debt_balance = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(balanceAfter, timestamp, timestamp, customer.id, tenantId)

      const cashOperationId = input.method === 'cash' && input.shift_id ? randomUUID() : null
      if (cashOperationId) {
        this.addCashOperation(tenantId, input.shift_id!, input.user_id ?? null, 'cash_in', amount, `Оплата боргу: ${customer.full_name ?? customer.phone ?? customer.id.slice(0, 8)}`, timestamp, cashOperationId)
      }

      this.addOutbox(tenantId, 'customer', customer.id, 'customer.debt_paid', {
        customer_id: customer.id,
        amount,
        method: input.method,
        shift_id: input.shift_id ?? null,
        cash_operation_id: cashOperationId,
        notes: input.notes ?? null,
        created_by: input.user_id ?? null,
        created_at: timestamp,
      }, timestamp)
      this.addAudit(tenantId, input.user_id ?? 'local', 'customer.debt_paid', 'customer', customer.id, { amount, method: input.method, debt_balance: balanceAfter }, timestamp)
      return { data: { ...customer, debt_balance: balanceAfter } }
    })
  }

  addCustomerDeposit(input: {
    tenant_id?: string
    customer_id: string
    amount: number
    method: 'cash' | 'card' | 'transfer'
    shift_id?: string | null
    user_id?: string | null
    notes?: string | null
  }): { data: { balance: number } } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const amount = money(input.amount)
    if (amount <= 0) throw new Error('Вкажіть коректну суму')
    if (input.method === 'cash' && !input.shift_id) {
      throw new Error('Для поповнення готівкою потрібна відкрита касова зміна')
    }
    return this.db.transaction(() => {
      const customer = this.getCustomerForMoney(input.customer_id, tenantId)
      const timestamp = nowIso()
      const balanceAfter = Number(customer.deposit_balance ?? 0) + amount
      const transactionId = randomUUID()
      this.db.prepare(`
        UPDATE customers
        SET deposit_balance = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(balanceAfter, timestamp, timestamp, customer.id, tenantId)
      this.db.prepare(`
        INSERT INTO customer_deposit_transactions (
          id, tenant_id, customer_id, amount, balance_after, method, shift_id,
          notes, created_by, dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(transactionId, tenantId, customer.id, amount, balanceAfter, input.method, input.shift_id ?? null, input.notes ?? 'Поповнення рахунку на касі', input.user_id ?? null, timestamp, timestamp, timestamp)

      const cashOperationId = input.method === 'cash' && input.shift_id ? randomUUID() : null
      if (cashOperationId) {
        this.addCashOperation(tenantId, input.shift_id!, input.user_id ?? null, 'cash_in', amount, `Поповнення рахунку клієнта: ${customer.full_name ?? customer.phone ?? customer.id.slice(0, 8)}`, timestamp, cashOperationId)
      }

      this.addOutbox(tenantId, 'customer', customer.id, 'customer.deposit_changed', {
        customer_id: customer.id,
        transaction_id: transactionId,
        amount,
        method: input.method,
        shift_id: input.shift_id ?? null,
        cash_operation_id: cashOperationId,
        notes: input.notes ?? 'Поповнення рахунку на касі',
        created_by: input.user_id ?? null,
        created_at: timestamp,
      }, timestamp)
      this.addAudit(tenantId, input.user_id ?? 'local', 'customer.deposit_changed', 'customer', customer.id, { amount, method: input.method, balance_after: balanceAfter }, timestamp)
      return { data: { balance: balanceAfter } }
    })
  }
  getSale(saleId: string, tenantId = DEFAULT_TENANT_ID): any {
    const row = this.db.prepare(`
      SELECT s.*, c.phone AS customer_phone, c.full_name AS customer_name
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id AND c.tenant_id = s.tenant_id
      WHERE s.id = ? AND s.tenant_id = ? AND s.deleted_at IS NULL
      LIMIT 1
    `).get(saleId, tenantId) as any
    if (!row) throw new Error('Чек не знайдено')
    return this.decorateSale(row, tenantId)
  }

  listSales(input: { tenant_id?: string; search?: string; status?: string; product_barcode?: string; date_from?: string; date_to?: string; page?: number; per_page?: number } = {}): {
    data: any[]
    pagination: { page: number; per_page: number; total: number; total_pages: number }
  } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const page = Math.max(1, Number(input.page ?? 1) || 1)
    const perPage = Math.max(1, Math.min(200, Number(input.per_page ?? 20) || 20))
    const where = ['s.tenant_id = ?', 's.deleted_at IS NULL']
    const params: any[] = [tenantId]
    if (input.status) {
      where.push('s.status = ?')
      params.push(input.status)
    }
    const productBarcode = String(input.product_barcode ?? '').trim()
    if (productBarcode) {
      where.push(`EXISTS (
        SELECT 1
        FROM sale_items si
        LEFT JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
        LEFT JOIN product_barcodes pb ON pb.product_id = si.product_id AND pb.tenant_id = si.tenant_id AND pb.deleted_at IS NULL
        WHERE si.sale_id = s.id
          AND si.tenant_id = s.tenant_id
          AND si.deleted_at IS NULL
          AND (COALESCE(p.barcode, '') = ? OR COALESCE(p.sku, '') = ? OR COALESCE(pb.barcode, '') = ?)
      )`)
      params.push(productBarcode, productBarcode, productBarcode)
    }
    if (input.date_from) {
      where.push('COALESCE(s.completed_at, s.created_at) >= ?')
      params.push(input.date_from)
    }
    if (input.date_to) {
      where.push('COALESCE(s.completed_at, s.created_at) <= ?')
      params.push(input.date_to)
    }
    const raw = String(input.search ?? '').trim()
    if (raw) {
      const lower = raw.toLocaleLowerCase('uk-UA')
      const title = lower.replace(/(^|\s)\S/g, (char) => char.toLocaleUpperCase('uk-UA'))
      const q = `%${raw}%`
      where.push(`(
        s.sale_number LIKE ?
        OR COALESCE(c.phone, '') LIKE ?
        OR COALESCE(c.card_barcode, '') LIKE ?
        OR COALESCE(c.full_name, '') LIKE ?
        OR COALESCE(c.full_name, '') LIKE ?
        OR EXISTS (
          SELECT 1 FROM customer_vehicles v
          WHERE v.customer_id = c.id AND v.tenant_id = s.tenant_id
            AND v.deleted_at IS NULL AND upper(COALESCE(v.vin, '')) LIKE upper(?)
        )
      )`)
      params.push(q, q, q, q, `%${title}%`, q)
    }
    const whereSql = where.join(' AND ')
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id AND c.tenant_id = s.tenant_id
      WHERE ${whereSql}
    `).get(...params) as { total: number }
    const rows = this.db.prepare(`
      SELECT s.*, c.phone AS customer_phone, c.full_name AS customer_name,
             EXISTS (
               SELECT 1 FROM customer_orders o
               WHERE o.tenant_id = s.tenant_id
                 AND o.sale_id = s.id
                 AND o.deleted_at IS NULL
             ) AS is_order_sale
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id AND c.tenant_id = s.tenant_id
      WHERE ${whereSql}
      ORDER BY COALESCE(s.completed_at, s.created_at) DESC
      LIMIT ? OFFSET ?
    `).all(...params, perPage, (page - 1) * perPage) as any[]
    const total = Number(totalRow?.total ?? 0)
    return {
      data: rows.map((row) => this.decorateSale(row, tenantId)),
      pagination: { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) },
    }
  }

  calculatePrices(items: Array<{ product_id: string; qty: number }>, tenantId = DEFAULT_TENANT_ID): any[] {
    return items.map((item) => {
      const product = this.getProductForUpdate(item.product_id, tenantId)
      if (!product) throw new Error('Товар не знайдено')
      const qty = Number(item.qty ?? 0)
      return {
        product_id: product.id,
        sku: product.sku,
        name: product.name,
        unit: product.unit,
        unit_price: Number(product.retail_price ?? 0),
        qty,
        total: Number(product.retail_price ?? 0) * qty,
        in_stock: Number(product.qty_on_hand ?? 0) >= qty,
        qty_on_hand: Number(product.qty_on_hand ?? 0),
      }
    })
  }

  suspendSale(input: any): { data: any } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    if (!input.shift_id) throw new Error('Касову зміну не відкрито')
    const timestamp = nowIso()
    const saleId = randomUUID()
    const saleNumber = this.nextSaleNumber(tenantId, timestamp)
    const prepared = (input.items ?? []).map((item: any) => {
      const product = this.getProductForUpdate(item.product_id, tenantId)
      if (!product) throw new Error('Товар не знайдено')
      const qty = Number(item.qty ?? 0)
      if (qty <= 0) throw new Error('Некоректна кількість')
      const unitPrice = money(item.unit_price ?? product.retail_price)
      const discount = money(item.discount ?? 0)
      return {
        id: randomUUID(), product_id: product.id, description: product.name, sku: product.sku,
        qty, unit_price: unitPrice, purchase_price: product.purchase_price,
        discount, total: lineTotal(qty, unitPrice, discount),
      }
    })
    if (!prepared.length) throw new Error('Чек порожній')
    const subtotal = prepared.reduce((sum: number, item: any) => sum + item.total, 0)
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO sales (
          id, tenant_id, sale_number, customer_id, cashier_id, manager_id, shift_id,
          status, subtotal, discount, total, payment_method, is_debt, is_fiscal,
          cash_amount, card_amount, transfer_amount, debt_amount, pickup_cell, notes,
          dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'suspended', ?, 0, ?, ?, 0, 0, 0, 0, 0, 0, ?, ?, ?, ?, ?)
      `).run(
        saleId, tenantId, saleNumber, input.customer_id ?? null,
        input.cashier_id ?? input.manager_id ?? 'local', input.manager_id ?? null, input.shift_id,
        subtotal, subtotal, input.payment_method ?? 'cash', input.pickup_cell ?? null,
        input.notes ?? null, timestamp, timestamp, timestamp,
      )
      for (const item of prepared) {
        this.db.prepare(`
          INSERT INTO sale_items (
            id, tenant_id, sale_id, product_id, description, sku, qty, unit_price,
            purchase_price, discount, total, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.id, tenantId, saleId, item.product_id, item.description, item.sku,
          item.qty, item.unit_price, item.purchase_price, item.discount, item.total,
          timestamp, timestamp,
        )
      }
      this.addOutbox(tenantId, 'sale', saleId, 'sale.suspended', {
        id: saleId, sale_number: saleNumber, ...input, subtotal, total: subtotal, created_at: timestamp,
      }, timestamp)
    })
    return { data: this.getSale(saleId, tenantId) }
  }

  listSuspendedSales(tenantId = DEFAULT_TENANT_ID): any[] {
    return this.listSales({ tenant_id: tenantId, status: 'suspended', page: 1, per_page: 200 }).data
  }

  resumeSale(saleId: string, tenantId = DEFAULT_TENANT_ID): { data: any } {
    const sale = this.getSale(saleId, tenantId)
    if (sale.status !== 'suspended') throw new Error('Чек вже не відкладений')
    return { data: sale }
  }

  confirmResumeSale(saleId: string, tenantId = DEFAULT_TENANT_ID): { data: any } {
    const sale = this.getSale(saleId, tenantId)
    if (sale.status !== 'suspended') throw new Error('Чек вже не відкладений')
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE sales SET status = 'cancelled', dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(timestamp, timestamp, saleId, tenantId)
    this.addOutbox(tenantId, 'sale', saleId, 'sale.suspended_resumed', { id: saleId }, timestamp)
    return { data: { ...sale, status: 'cancelled' } }
  }

  discardSuspendedSale(saleId: string, tenantId = DEFAULT_TENANT_ID): { data: any } {
    const sale = this.getSale(saleId, tenantId)
    if (sale.status !== 'suspended') throw new Error('Чек вже не відкладений')
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE sales SET status = 'cancelled', deleted_at = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(timestamp, timestamp, timestamp, saleId, tenantId)
    this.addOutbox(tenantId, 'sale', saleId, 'sale.suspended_deleted', { id: saleId }, timestamp)
    return { data: { ...sale, status: 'cancelled' } }
  }

  checkSaleAfterPayment(shiftId: string, after: string, tenantId = DEFAULT_TENANT_ID): any | null {
    const row = this.db.prepare(`
      SELECT id FROM sales
      WHERE tenant_id = ? AND shift_id = ? AND deleted_at IS NULL
        AND status = 'completed' AND created_at >= ?
      ORDER BY created_at DESC LIMIT 1
    `).get(tenantId, shiftId, after) as { id: string } | undefined
    return row ? this.getSale(row.id, tenantId) : null
  }
  createCashOperation(input: {
    tenant_id?: string
    shift_id: string
    user_id?: string | null
    type: 'in' | 'out'
    amount: number
    note?: string | null
    source?: string
  }): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const amount = money(input.amount)
    if (amount <= 0) throw new Error('Вкажіть суму більше нуля')
    const shift = this.db.prepare(`
      SELECT id FROM shifts
      WHERE id = ? AND tenant_id = ? AND status = 'open' AND deleted_at IS NULL
    `).get(input.shift_id, tenantId) as { id: string } | undefined
    if (!shift) throw new Error('Касову зміну не знайдено або вже закрито')
    const timestamp = nowIso()
    const id = randomUUID()
    const dbType = input.type === 'in' ? 'cash_in' : 'cash_out'
    this.db.prepare(`
      INSERT INTO cash_operations (
        id, tenant_id, shift_id, user_id, type, source, amount, notes,
        dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, tenantId, input.shift_id, input.user_id ?? null, dbType,
      input.source ?? 'cashbox', amount, input.note ?? null,
      timestamp, timestamp, timestamp,
    )
    this.addOutbox(tenantId, 'cash_operation', id, 'cash_operation.created', {
      id, shift_id: input.shift_id, type: input.type, amount,
      note: input.note ?? null, source: input.source ?? 'cashbox',
      user_id: input.user_id ?? null,
    }, timestamp)
    return {
      id, shift_id: input.shift_id, type: input.type, amount,
      note: input.note ?? null, created_by: input.user_id ?? 'local', created_at: timestamp,
    }
  }

  listCashOperations(shiftId: string, tenantId = DEFAULT_TENANT_ID): any[] {
    const rows = this.db.prepare(`
      SELECT id, shift_id, user_id, type, amount, notes, created_at
      FROM cash_operations
      WHERE shift_id = ? AND tenant_id = ? AND deleted_at IS NULL AND type IN ('cash_in', 'cash_out')
      ORDER BY created_at DESC
    `).all(shiftId, tenantId) as any[]
    return rows.map((row) => ({
      id: row.id,
      shift_id: row.shift_id,
      type: row.type === 'cash_in' ? 'in' : 'out',
      amount: Number(row.amount),
      note: row.notes ?? null,
      created_by: row.user_id ?? 'local',
      created_at: row.created_at,
    }))
  }

  getCashOperationSummary(shiftId: string, tenantId = DEFAULT_TENANT_ID): {
    total_in: number
    total_out: number
    net: number
  } {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'cash_in' THEN amount ELSE 0 END), 0) AS total_in,
        COALESCE(SUM(CASE WHEN type = 'cash_out' THEN amount ELSE 0 END), 0) AS total_out
      FROM cash_operations
      WHERE shift_id = ? AND tenant_id = ?
    `).get(shiftId, tenantId) as { total_in: number; total_out: number }
    const totalIn = Number(row?.total_in ?? 0)
    const totalOut = Number(row?.total_out ?? 0)
    return { total_in: totalIn, total_out: totalOut, net: totalIn - totalOut }
  }
  // Очікувана готівка у відкритій зміні (звірка каси) — з локальних даних.
  getExpectedCash(cashierId: string, tenantId = DEFAULT_TENANT_ID): {
    opening_cash: number
    cash_sales: number
    cash_returns: number
    cash_in: number
    cash_out: number
    expected_amount: number
  } | null {
    const shift = this.getOpenShift(cashierId, tenantId)
    if (!shift) return null
    const rows = this.db.prepare(`
      SELECT type, SUM(amount) AS total
      FROM cash_operations
      WHERE tenant_id = ? AND shift_id = ? AND deleted_at IS NULL
      GROUP BY type
    `).all(tenantId, shift.id) as Array<{ type: string; total: number }>
    const by: Record<string, number> = {}
    for (const r of rows) by[r.type] = Number(r.total) || 0
    const cash_sales = by['sale_cash'] ?? 0
    const cash_returns = by['return_cash'] ?? 0
    const cash_in = by['cash_in'] ?? 0
    const cash_out = (by['cash_out'] ?? 0) + (by['salary_payout'] ?? 0) + (by['supplier_payment'] ?? 0)
    const expected = shift.opening_cash + cash_sales + cash_in - cash_returns - cash_out
    return {
      opening_cash: shift.opening_cash,
      cash_sales,
      cash_returns,
      cash_in,
      cash_out,
      expected_amount: Math.max(0, expected),
    }
  }

  getShiftReport(cashierId: string, tenantId = DEFAULT_TENANT_ID): {
    shift: NonNullable<ReturnType<LocalPosRepository['getOpenShift']>>
    total_sales: number
    total_revenue: number
    payment_received_total: number
    by_method: { cash: number; card: number; transfer: number; account: number; debt: number }
    sales: Array<{
      id: string
      sale_number: string
      total: number
      payment_method: string
      status: string
      completed_at: string
    }>
  } | null {
    const shift = this.getOpenShift(cashierId, tenantId)
    if (!shift) return null
    const sales = this.db.prepare(`
      SELECT s.id, s.sale_number, s.total, s.payment_method, s.status, s.completed_at,
             s.cash_amount, s.card_amount, s.transfer_amount, s.debt_amount,
             EXISTS (
               SELECT 1 FROM customer_orders o
               WHERE o.tenant_id = s.tenant_id
                 AND o.sale_id = s.id
                 AND o.deleted_at IS NULL
             ) AS is_order_sale
      FROM sales s
      WHERE s.tenant_id = ? AND s.shift_id = ? AND s.deleted_at IS NULL
      ORDER BY s.completed_at ASC
    `).all(tenantId, shift.id) as unknown as Array<{
      id: string
      sale_number: string
      total: number
      payment_method: string
      status: string
      completed_at: string
      cash_amount: number
      card_amount: number
      transfer_amount: number
      debt_amount: number
      is_order_sale: number
    }>
    const completed = sales.filter((sale) => sale.status === 'completed')
    const regularSales = completed.filter((sale) => sale.is_order_sale !== 1)
    const orderPayments = this.db.prepare(`
      SELECT amount, method
      FROM order_payments
      WHERE tenant_id = ? AND shift_id = ? AND deleted_at IS NULL
    `).all(tenantId, shift.id) as Array<{ amount: number; method: 'cash' | 'card' | 'transfer' | 'account' }>

    const byMethod = { cash: 0, card: 0, transfer: 0, account: 0, debt: 0 }
    for (const sale of regularSales) {
      const total = Number(sale.total ?? 0)
      byMethod.cash += Number(sale.cash_amount ?? 0) || (sale.payment_method === 'cash' ? total : 0)
      byMethod.card += Number(sale.card_amount ?? 0) || (sale.payment_method === 'card' ? total : 0)
      byMethod.transfer += Number(sale.transfer_amount ?? 0) || (sale.payment_method === 'transfer' ? total : 0)
      byMethod.debt += Number(sale.debt_amount ?? 0) || (sale.payment_method === 'debt' ? total : 0)
    }
    for (const payment of orderPayments) {
      const amount = Number(payment.amount ?? 0)
      if (payment.method === 'cash') byMethod.cash += amount
      else if (payment.method === 'card') byMethod.card += amount
      else if (payment.method === 'transfer') byMethod.transfer += amount
      else if (payment.method === 'account') byMethod.account += amount
    }

    return {
      shift,
      total_sales: completed.length,
      total_revenue: completed.reduce((sum, sale) => sum + Number(sale.total || 0), 0),
      payment_received_total: byMethod.cash + byMethod.card + byMethod.transfer + byMethod.account,
      by_method: byMethod,
      sales,
    }
  }

  // Зберегти звірку каси локально (оновлюємо зміну очікуваною сумою й розбіжністю).
  reconcileShift(cashierId: string, actualAmount: number, comment: string | null, tenantId = DEFAULT_TENANT_ID): { ok: true } {
    const shift = this.getOpenShift(cashierId, tenantId)
    if (!shift) throw new Error('LOCAL_NO_SHIFT')
    const exp = this.getExpectedCash(cashierId, tenantId)
    const expected = exp?.expected_amount ?? 0
    const variance = Math.round(actualAmount) - expected
    const ts = new Date().toISOString()
    const note = comment && comment.trim()
      ? `${shift.notes ? shift.notes + '\n' : ''}Звірка: ${comment.trim()}`
      : shift.notes
    this.db.prepare(`
      UPDATE shifts
      SET expected_cash = ?, cash_variance = ?, notes = ?, dirty_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(expected, variance, note ?? null, ts, ts, shift.id, tenantId)
    return { ok: true }
  }

  closeShift(cashierId: string, actualAmount: number, comment: string | null, tenantId = DEFAULT_TENANT_ID): { ok: true; id: string } {
    return this.db.transaction(() => {
      const shift = this.getOpenShift(cashierId, tenantId)
      if (!shift) throw new Error('LOCAL_NO_SHIFT')
      const expected = this.getExpectedCash(cashierId, tenantId)?.expected_amount ?? 0
      const closingCash = money(actualAmount)
      const variance = closingCash - expected
      const timestamp = nowIso()
      const note = comment?.trim()
        ? `${shift.notes ? shift.notes + '\n' : ''}${comment.trim()}`
        : shift.notes

      this.db.prepare(`
        UPDATE shifts
        SET status = 'closed', closing_cash = ?, expected_cash = ?, cash_variance = ?,
            closed_at = ?, notes = ?, dirty_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
      `).run(
        closingCash,
        expected,
        variance,
        timestamp,
        note ?? null,
        timestamp,
        timestamp,
        shift.id,
        tenantId,
      )

      this.addOutbox(
        tenantId,
        'shift',
        shift.id,
        'shift.closed',
        {
          id: shift.id,
          cashier_id: cashierId,
          closing_cash: closingCash,
          expected_cash: expected,
          cash_variance: variance,
          closed_at: timestamp,
          notes: note ?? null,
        },
        timestamp,
      )
      return { ok: true, id: shift.id }
    })
  }

  checkout(input: LocalSaleCheckoutInput): LocalSaleCheckoutResult {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const clientOperationId = operationId(input.client_operation_id)
    const checkoutHash = this.checkoutPayloadHash(input, tenantId)
    if (clientOperationId) {
      const existing = this.existingCheckoutResult(tenantId, clientOperationId, checkoutHash)
      if (existing) return existing
    }
    this.assertCheckoutReady(input)
    if (input.is_fiscal === true) {
      if (!clientOperationId) throw new Error('FISCAL_OPERATION_ID_REQUIRED')
      this.assertFiscalIntentCanCheckout(clientOperationId, checkoutHash, input.fiscal_number)
    }

    return this.db.transaction(() => {
      if (clientOperationId) {
        const existing = this.existingCheckoutResult(tenantId, clientOperationId, checkoutHash)
        if (existing) return existing
      }
      if (input.is_fiscal === true && clientOperationId) {
        this.assertFiscalIntentCanCheckout(clientOperationId, checkoutHash, input.fiscal_number)
      }
      this.assertSaleStockAvailable(input.items, tenantId)
      const timestamp = nowIso()
      const saleId = randomUUID()
      const shiftId = input.shift_id ?? this.findOpenShift(input.cashier_id, tenantId)
      if (!shiftId) throw new Error('LOCAL_OPEN_SHIFT_REQUIRED')

      const saleNumber = this.nextSaleNumber(tenantId, timestamp)
      const payments = this.summarizePayments(input.payments)
      let subtotal = 0
      let itemDiscountTotal = 0
      const preparedItems = input.items.map((item) => {
        if (item.qty <= 0) throw new Error('LOCAL_SALE_INVALID_QTY')
        const product = item.product_id
          ? this.getProductForUpdate(item.product_id, tenantId)
          : null
        if (item.product_id && !product) throw new Error('LOCAL_PRODUCT_NOT_FOUND')

        const unitPrice = money(item.unit_price ?? product?.retail_price ?? 0)
        if (unitPrice <= 0) throw new Error('LOCAL_SALE_INVALID_PRICE')

        const gross = money(item.qty * unitPrice)
        const itemDiscount = Math.min(gross, money(item.discount ?? 0))
        const coreDepositAmount = product?.requires_core_return === 1
          ? money(product.core_deposit_amount ?? 0)
          : 0
        const total = gross - itemDiscount + money(coreDepositAmount * item.qty)
        subtotal += gross + money(coreDepositAmount * item.qty)
        itemDiscountTotal += itemDiscount

        return {
          id: randomUUID(),
          product,
          product_id: product?.id ?? null,
          description: item.description ?? product?.name ?? 'Вільна сума',
          sku: product?.sku ?? null,
          qty: item.qty,
          unit_price: unitPrice,
          purchase_price: product?.purchase_price ?? 0,
          discount: itemDiscount,
          total,
          core_deposit_amount: coreDepositAmount,
          core_return_status: coreDepositAmount > 0 ? 'pending' : 'none',
        }
      })

      const bonusesSpent = money(input.bonuses_spent ?? 0)
      if (bonusesSpent > 0 && !input.customer_id) throw new Error('Для списання бонусів виберіть клієнта')
      let bonusCustomer: ReturnType<LocalPosRepository['getCustomerForMoney']> | null = null
      if (bonusesSpent > 0 && input.customer_id) {
        bonusCustomer = this.getCustomerForMoney(input.customer_id, tenantId)
        const bonusBalance = Number((bonusCustomer as any).bonus_balance ?? 0)
        if (bonusesSpent > bonusBalance) throw new Error('Недостатньо бонусів у клієнта')
      }
      const discount = itemDiscountTotal + money(input.discount ?? 0)
      const total = Math.max(0, subtotal - discount)
      const paidTotal = payments.cash + payments.card + payments.transfer + payments.debt
      if (paidTotal !== total) throw new Error('LOCAL_SALE_PAYMENT_MISMATCH')

      const method = paymentMethod(input.payments)
      this.db.prepare(`
        INSERT INTO sales (
          id, tenant_id, sale_number, customer_id, cashier_id, manager_id, shift_id,
          status, subtotal, discount, total, payment_method, is_debt, is_fiscal,
          fiscal_number, fiscal_qr_url, client_operation_id, client_payload_hash,
          cash_amount, card_amount, transfer_amount, debt_amount, notes,
          completed_at, dirty_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        saleId,
        tenantId,
        saleNumber,
        input.customer_id ?? null,
        input.cashier_id,
        input.manager_id ?? null,
        shiftId,
        subtotal,
        discount,
        total,
        method,
        payments.debt > 0 ? 1 : 0,
        input.is_fiscal === true ? 1 : 0,
        input.fiscal_number ?? null,
        input.fiscal_qr_url ?? null,
        clientOperationId,
        clientOperationId ? checkoutHash : null,
        payments.cash,
        payments.card,
        payments.transfer,
        payments.debt,
        input.notes ?? null,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )

      for (const item of preparedItems) {
        this.db.prepare(`
          INSERT INTO sale_items (
            id, tenant_id, sale_id, product_id, description, sku, qty, unit_price,
            purchase_price, discount, total, core_deposit_amount, core_return_status,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.id,
          tenantId,
          saleId,
          item.product_id,
          item.description,
          item.sku,
          item.qty,
          item.unit_price,
          item.purchase_price,
          item.discount,
          item.total,
          item.core_deposit_amount,
          item.core_return_status,
          timestamp,
          timestamp,
        )

        if (item.product && item.product.is_service !== 1) {
          const qtyAfter = Number(item.product.qty_on_hand) - Number(item.qty)
          this.db.prepare(`
            UPDATE products
            SET qty_on_hand = ?, dirty_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ?
          `).run(qtyAfter, timestamp, timestamp, item.product.id, tenantId)

          this.db.prepare(`
            INSERT INTO inventory_movements (
              id, tenant_id, product_id, source_type, source_id, qty_delta, qty_after,
              unit_cost, notes, dirty_at, created_at, updated_at
            )
            VALUES (?, ?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            tenantId,
            item.product.id,
            saleId,
            -Number(item.qty),
            qtyAfter,
            item.purchase_price,
            `Sale ${saleNumber}`,
            timestamp,
            timestamp,
            timestamp,
          )
        }
      }

      for (const payment of input.payments) {
        this.db.prepare(`
          INSERT INTO sale_payments (
            id, tenant_id, sale_id, method, amount, is_fiscal, fiscal_number,
            bank_auth_code, terminal_rrn, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          tenantId,
          saleId,
          payment.method,
          payment.amount,
          payment.is_fiscal === true ? 1 : 0,
          payment.fiscal_number ?? null,
          payment.bank_auth_code ?? null,
          payment.terminal_rrn ?? null,
          timestamp,
          timestamp,
        )
      }

      if (bonusesSpent > 0 && input.customer_id && bonusCustomer) {
        const balanceAfter = Number((bonusCustomer as any).bonus_balance ?? 0) - bonusesSpent
        this.db.prepare(`
          UPDATE customers SET bonus_balance = ?, dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).run(balanceAfter, timestamp, timestamp, input.customer_id, tenantId)
        this.db.prepare(`
          INSERT INTO bonus_transactions (
            id, tenant_id, customer_id, amount, transaction_type, source_sale_id,
            description, created_by, dirty_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'spend', ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), tenantId, input.customer_id, -bonusesSpent, saleId,
          `Списання бонусів за чеком ${saleNumber}`, input.cashier_id,
          timestamp, timestamp, timestamp,
        )
      }
      if (payments.debt > 0 && input.customer_id) {
        const customer = this.getCustomerForMoney(input.customer_id, tenantId)
        this.db.prepare(`
          UPDATE customers
          SET debt_balance = ?, dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).run(Number(customer.debt_balance ?? 0) + payments.debt, timestamp, timestamp, input.customer_id, tenantId)
      }
      if (input.customer_id && payments.debt === 0) {
        const customer = this.getCustomerForMoney(input.customer_id, tenantId)
        const cashbackPct = customer.loyalty_mode === 'cashback' ? Number(customer.discount_pct ?? 0) : 0
        const coreDepositTotal = preparedItems.reduce(
          (sum, item) => sum + money(item.core_deposit_amount * item.qty),
          0,
        )
        const cashbackBase = Math.max(0, total - coreDepositTotal)
        const cashback = cashbackPct > 0 ? Math.round(cashbackBase * cashbackPct / 100) : 0
        if (cashback > 0) {
          const balanceAfter = Number(customer.deposit_balance ?? 0) + cashback
          const transactionId = randomUUID()
          const notes = 'Накопичення ' + cashbackPct + '% з чека ' + saleNumber
          this.db.prepare(`
            UPDATE customers
            SET deposit_balance = ?, dirty_at = ?, updated_at = ?
            WHERE id = ? AND tenant_id = ?
          `).run(balanceAfter, timestamp, timestamp, input.customer_id, tenantId)
          this.db.prepare(`
            INSERT INTO customer_deposit_transactions (
              id, tenant_id, customer_id, amount, balance_after, method, sale_id, shift_id,
              notes, created_by, dirty_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'cashback', ?, ?, ?, ?, ?, ?, ?)
          `).run(
            transactionId, tenantId, input.customer_id, cashback, balanceAfter, saleId, shiftId,
            notes, input.cashier_id, timestamp, timestamp, timestamp,
          )
          this.addOutbox(tenantId, 'customer', input.customer_id, 'customer.deposit_changed', {
            customer_id: input.customer_id, transaction_id: transactionId, amount: cashback, method: 'cashback',
            sale_id: saleId, shift_id: shiftId, notes, created_by: input.cashier_id, created_at: timestamp,
          }, timestamp)
        }
      }
      if (payments.cash > 0) {
        this.db.prepare(`
          INSERT INTO cash_operations (
            id, tenant_id, shift_id, user_id, type, source, amount, sale_id,
            notes, dirty_at, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, 'sale_cash', 'cashbox', ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          tenantId,
          shiftId,
          input.cashier_id,
          payments.cash,
          saleId,
          `Cash payment ${saleNumber}`,
          timestamp,
          timestamp,
          timestamp,
        )
      }

      const outboxSequence = this.addOutbox(
        tenantId,
        'sale',
        saleId,
        'sale.completed',
        {
          sale_id: saleId,
          sale_number: saleNumber,
          shift_id: shiftId,
          customer_id: input.customer_id ?? null,
          cashier_id: input.cashier_id,
          manager_id: input.manager_id ?? null,
          subtotal,
          discount,
          bonuses_spent: bonusesSpent,
          total,
          payment_method: method,
          is_fiscal: input.is_fiscal === true,
          fiscal_number: input.fiscal_number ?? null,
          client_operation_id: clientOperationId,
          fiscal_qr_url: input.fiscal_qr_url ?? null,
          payments: input.payments,
          items: preparedItems.map((item) => ({
            id: item.id,
            product_id: item.product_id,
            description: item.description,
            sku: item.sku,
            qty: item.qty,
            unit_price: item.unit_price,
            purchase_price: item.purchase_price,
            discount: item.discount,
            total: item.total,
            core_deposit_amount: item.core_deposit_amount,
            core_return_status: item.core_return_status,
          })),
          completed_at: timestamp,
        },
        timestamp,
      )

      this.addAudit(
        tenantId,
        input.cashier_id,
        'sale.completed',
        'sale',
        saleId,
        { sale_number: saleNumber, total, payment_method: method },
        timestamp,
      )

      new LocalStaffRepository(this.db).recordSaleCommissions(saleId, tenantId, input.cashier_id)

      const checkoutResult: LocalSaleCheckoutResult = {
        sale_id: saleId,
        sale_number: saleNumber,
        total,
        subtotal,
        payment_method: method,
        outbox_sequence: outboxSequence,
      }
      if (input.is_fiscal === true && clientOperationId) {
        const completed = this.db.prepare(`
          UPDATE fiscal_sale_intents
          SET state = 'completed', sale_id = ?, checkout_result_json = ?,
              completed_at = ?, updated_at = ?
          WHERE operation_id = ? AND tenant_id = ? AND state = 'fiscalized'
        `).run(
          saleId,
          JSON.stringify(checkoutResult),
          timestamp,
          timestamp,
          clientOperationId,
          tenantId,
        ) as { changes: number | bigint }
        if (Number(completed.changes) !== 1) throw new Error('FISCAL_INTENT_NOT_READY')
      }
      return checkoutResult
    })
  }

  listReturns(input: { tenant_id?: string; page?: number; per_page?: number } = {}): {
    data: any[]
    pagination: { page: number; per_page: number; total: number; total_pages: number }
  } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const page = Math.max(1, Number(input.page ?? 1) || 1)
    const perPage = Math.max(1, Math.min(100, Number(input.per_page ?? 20) || 20))
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS total FROM customer_returns
      WHERE tenant_id = ? AND deleted_at IS NULL
    `).get(tenantId) as { total: number }
    const rows = this.db.prepare(`
      SELECT r.*, s.sale_number, s.total AS sale_total, c.phone AS customer_phone, c.full_name AS customer_name
      FROM customer_returns r
      JOIN sales s ON s.id = r.sale_id AND s.tenant_id = r.tenant_id
      LEFT JOIN customers c ON c.id = r.customer_id AND c.tenant_id = r.tenant_id
      WHERE r.tenant_id = ? AND r.deleted_at IS NULL
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `).all(tenantId, perPage, (page - 1) * perPage) as any[]
    const total = Number(totalRow?.total ?? 0)
    return {
      data: rows.map((row) => this.decorateReturn(row, tenantId)),
      pagination: { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) },
    }
  }

  getReturn(returnId: string, tenantId = DEFAULT_TENANT_ID): any {
    const row = this.db.prepare(`
      SELECT r.*, s.sale_number, s.total AS sale_total, c.phone AS customer_phone, c.full_name AS customer_name
      FROM customer_returns r
      JOIN sales s ON s.id = r.sale_id AND s.tenant_id = r.tenant_id
      LEFT JOIN customers c ON c.id = r.customer_id AND c.tenant_id = r.tenant_id
      WHERE r.id = ? AND r.tenant_id = ? AND r.deleted_at IS NULL
      LIMIT 1
    `).get(returnId, tenantId) as any
    if (!row) throw new Error('Повернення не знайдено')
    return this.decorateReturn(row, tenantId)
  }

  getSaleForReturn(saleId: string, tenantId = DEFAULT_TENANT_ID): any {
    const sale = this.getSale(saleId, tenantId)
    if (!['completed', 'returned'].includes(sale.status)) {
      throw new Error('Цей чек не можна повернути')
    }
    const rows = this.db.prepare(`
      SELECT si.id, si.product_id, COALESCE(p.name, si.description, '') AS product_name,
             COALESCE(si.sku, p.sku, '') AS sku, COALESCE(p.unit, 'шт') AS unit,
             si.qty, si.unit_price, COALESCE(si.discount, 0) AS discount,
             si.total, COALESCE(si.core_deposit_amount, 0) AS core_deposit_amount,
             COALESCE((
               SELECT SUM(ri.quantity)
               FROM customer_return_items ri
               JOIN customer_returns r
                 ON r.id = ri.return_id
                AND r.tenant_id = si.tenant_id
                AND r.sale_id = si.sale_id
               WHERE ri.sale_item_id = si.id
                 AND ri.tenant_id = si.tenant_id
                 AND ri.deleted_at IS NULL
                 AND r.deleted_at IS NULL
             ), 0) AS already_returned_qty,
             COALESCE((
               SELECT SUM(ri.total_kopecks)
               FROM customer_return_items ri
               JOIN customer_returns r
                 ON r.id = ri.return_id
                AND r.tenant_id = si.tenant_id
                AND r.sale_id = si.sale_id
               WHERE ri.sale_item_id = si.id
                 AND ri.tenant_id = si.tenant_id
                 AND ri.deleted_at IS NULL
                 AND r.deleted_at IS NULL
             ), 0) AS already_refunded_kopecks
      FROM sale_items si
      JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
      WHERE si.sale_id = ? AND si.tenant_id = ? AND si.deleted_at IS NULL
      ORDER BY si.created_at ASC
    `).all(saleId, tenantId) as unknown as ReturnableSaleItemRow[]
    const allocation = allocateRefundPool(Number(sale.total), rows)
    const alreadyRefunded = rows.reduce(
      (sum, item) => sum + money(Number(item.already_refunded_kopecks ?? 0)),
      0,
    )
    if (
      alreadyRefunded < 0
      || alreadyRefunded > allocation.productRefundPool
      || rows.some((item) => (
        Number(item.already_returned_qty) < 0
        || Number(item.already_returned_qty) > Number(item.qty)
        || Number(item.already_refunded_kopecks) < 0
        || Number(item.already_refunded_kopecks) > (allocation.lineRefunds.get(item.id) ?? 0)
      ))
    ) {
      throw new Error('У чеку є некоректні дані попереднього повернення')
    }
    const items = rows.map((item) => {
      const refundableTotal = allocation.lineRefunds.get(item.id) ?? 0
      const alreadyReturnedQty = Number(item.already_returned_qty)
      const alreadyRefundedKopecks = money(Number(item.already_refunded_kopecks))
      return {
        id: item.id,
        product_id: item.product_id,
        product_name: item.product_name,
        sku: item.sku,
        unit: item.unit,
        qty: Number(item.qty),
        unit_price: Number(item.unit_price),
        total: Number(item.total),
        refundable_total: refundableTotal,
        already_returned_qty: alreadyReturnedQty,
        already_refunded_kopecks: alreadyRefundedKopecks,
        available_qty: Math.max(0, Number(item.qty) - alreadyReturnedQty),
        refundable_kopecks: Math.max(0, refundableTotal - alreadyRefundedKopecks),
      }
    })
    return {
      sale: {
        id: sale.id,
        sale_number: sale.sale_number,
        status: sale.status,
        customer_id: sale.customer_id,
        total: sale.total,
        completed_at: sale.completed_at,
        is_fiscal: sale.is_fiscal,
        fiscal_number: sale.fiscal_number,
        product_refund_pool: allocation.productRefundPool,
        already_refunded_kopecks: alreadyRefunded,
        refundable_kopecks: Math.max(0, allocation.productRefundPool - alreadyRefunded),
      },
      items,
    }
  }

  createReturn(input: any): any {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const clientOperationId = operationId(input.client_operation_id)
    const returnHash = this.returnPayloadHash(input, tenantId)
    if (clientOperationId) {
      const existing = this.existingReturnResult(tenantId, clientOperationId, returnHash)
      if (existing) return existing
    }

    if (input.is_fiscal === true) {
      if (!clientOperationId) throw new Error('FISCAL_OPERATION_ID_REQUIRED')
      this.assertReturnReady(input)
      this.assertFiscalIntentCanReturn(clientOperationId, returnHash, input.fiscal_number)
    }

    const returnId = randomUUID()
    const timestamp = nowIso()

    return this.db.transaction(() => {
      if (clientOperationId) {
        const existing = this.existingReturnResult(tenantId, clientOperationId, returnHash)
        if (existing) return existing
      }
      if (input.is_fiscal === true && clientOperationId) {
        this.assertFiscalIntentCanReturn(clientOperationId, returnHash, input.fiscal_number)
      }
      const ready = this.assertReturnReady(input)
      const normalized = ready.normalized.map((item) => ({ ...item, id: randomUUID() }))

      this.db.prepare(`
        INSERT INTO customer_returns (
          id, tenant_id, sale_id, customer_id, return_type, reason, reason_note,
          refund_method, refund_kopecks, stock_action, status, approved_by,
          fiscal_number, client_operation_id, client_payload_hash,
          dirty_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'customer_return', ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        returnId,
        tenantId,
        ready.sale.id,
        ready.sale.customer_id ?? null,
        String(input.reason ?? 'other'),
        input.reason_note ?? null,
        String(input.refund_method ?? 'cash'),
        ready.refund,
        String(input.stock_action ?? 'return_to_stock'),
        ready.approved_by,
        input.fiscal_number ?? null,
        clientOperationId,
        clientOperationId ? returnHash : null,
        timestamp,
        timestamp,
        timestamp,
      )

      for (const item of normalized) {
        this.db.prepare(`
          INSERT INTO customer_return_items (
            id, tenant_id, return_id, sale_item_id, product_id, quantity,
            unit_price_kopecks, total_kopecks, condition, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.id,
          tenantId,
          returnId,
          item.sale_item_id,
          item.product_id,
          item.quantity,
          item.unit_price,
          item.total,
          item.condition,
          timestamp,
          timestamp,
        )
        if (input.stock_action === 'return_to_stock' && item.product_id) {
          const product = this.getProductForUpdate(item.product_id, tenantId)
          if (product) {
            const nextQty = Number(product.qty_on_hand ?? 0) + item.quantity
            this.db.prepare(`
              UPDATE products SET qty_on_hand = ?, dirty_at = ?, updated_at = ?
              WHERE id = ? AND tenant_id = ?
            `).run(nextQty, timestamp, timestamp, item.product_id, tenantId)
            this.db.prepare(`
              INSERT INTO inventory_movements (
                id, tenant_id, product_id, source_type, source_id, qty_delta, qty_after,
                unit_cost, notes, dirty_at, created_at, updated_at
              ) VALUES (?, ?, ?, 'customer_return', ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              randomUUID(),
              tenantId,
              item.product_id,
              returnId,
              item.quantity,
              nextQty,
              item.unit_price,
              `Повернення за чеком ${ready.sale.sale_number}`,
              timestamp,
              timestamp,
              timestamp,
            )
          }
        }
      }

      // Якщо чек створено під час видачі замовлення, відразу показуємо у його
      // картці лише ті позиції, які вже повернуті повністю.
      this.db.prepare(`
        UPDATE customer_order_items
        SET item_status = 'returned', dirty_at = ?, updated_at = ?
        WHERE tenant_id = ?
          AND deleted_at IS NULL
          AND order_id = (
            SELECT id FROM customer_orders
            WHERE sale_id = ? AND tenant_id = ? AND deleted_at IS NULL
            LIMIT 1
          )
          AND product_id IN (
            SELECT si.product_id
            FROM sale_items si
            LEFT JOIN (
              SELECT sale_item_id, SUM(quantity) AS qty
              FROM customer_return_items
              WHERE tenant_id = ?
              GROUP BY sale_item_id
            ) returned ON returned.sale_item_id = si.id
            WHERE si.sale_id = ? AND si.tenant_id = ? AND si.deleted_at IS NULL
            GROUP BY si.product_id
            HAVING COALESCE(SUM(returned.qty), 0) >= SUM(si.qty)
          )
      `).run(
        timestamp, timestamp, tenantId, ready.sale.id, tenantId,
        tenantId, ready.sale.id, tenantId,
      )

      if (input.refund_method === 'cash') {
        this.addCashOperation(
          tenantId,
          ready.shift_id,
          ready.approved_by,
          'return_cash',
          ready.refund,
          `Повернення за чеком ${ready.sale.sale_number}`,
          timestamp,
          returnId,
        )
      } else if (ready.sale.customer_id && input.refund_method === 'debt_reduction') {
        const updated = this.db.prepare(`
          UPDATE customers
          SET debt_balance = debt_balance - ?, dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
            AND COALESCE(debt_balance, 0) >= ?
        `).run(
          ready.refund,
          timestamp,
          timestamp,
          ready.sale.customer_id,
          tenantId,
          ready.refund,
        ) as { changes: number | bigint }
        if (Number(updated.changes) !== 1) {
          throw new Error('Сума боргу клієнта менша за суму повернення')
        }
      } else if (ready.sale.customer_id && input.refund_method === 'credit') {
        const customer = this.getCustomerForMoney(ready.sale.customer_id, tenantId)
        const balanceAfter = Number(customer.deposit_balance ?? 0) + ready.refund
        const updated = this.db.prepare(`
          UPDATE customers SET deposit_balance = ?, dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        `).run(balanceAfter, timestamp, timestamp, ready.sale.customer_id, tenantId) as {
          changes: number | bigint
        }
        if (Number(updated.changes) !== 1) {
          throw new Error('Клієнта не знайдено')
        }
        this.db.prepare(`
          INSERT INTO customer_deposit_transactions (
            id, tenant_id, customer_id, amount, balance_after, method, sale_id,
            shift_id, notes, created_by, dirty_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'return_credit', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          tenantId,
          ready.sale.customer_id,
          ready.refund,
          balanceAfter,
          ready.sale.id,
          ready.shift_id,
          `Повернення за чеком ${ready.sale.sale_number}`,
          ready.approved_by,
          timestamp,
          timestamp,
          timestamp,
        )
      }

      const remaining = this.getSaleForReturn(ready.sale.id, tenantId).items
        .reduce((sum: number, item: any) => sum + Number(item.available_qty ?? 0), 0)
      if (remaining <= 0) {
        this.db.prepare(`
          UPDATE sales SET status = 'returned', dirty_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?
        `).run(timestamp, timestamp, ready.sale.id, tenantId)
      }

      this.addOutbox(tenantId, 'customer_return', returnId, 'return.created', {
        id: returnId,
        client_operation_id: clientOperationId,
        sale_id: ready.sale.id,
        reason: input.reason,
        reason_note: input.reason_note ?? null,
        refund_method: input.refund_method,
        stock_action: input.stock_action,
        fiscal_number: input.fiscal_number ?? null,
        refund_kopecks: ready.refund,
        shift_id: ready.shift_id,
        items: normalized,
      }, timestamp)
      this.addAudit(tenantId, ready.approved_by, 'return.created', 'customer_return', returnId, {
        sale_id: ready.sale.id,
        refund_kopecks: ready.refund,
      }, timestamp)

      new LocalStaffRepository(this.db).recordReturnCommissionReversals(
        returnId, ready.sale.id, normalized, tenantId, ready.approved_by,
      )

      const result = this.getReturn(returnId, tenantId)
      if (input.is_fiscal === true && clientOperationId) {
        const completed = this.db.prepare(`
          UPDATE fiscal_sale_intents
          SET state = 'completed', return_id = ?, checkout_result_json = ?,
              completed_at = ?, updated_at = ?
          WHERE operation_id = ? AND tenant_id = ?
            AND operation_kind = 'return' AND state = 'fiscalized'
        `).run(
          returnId,
          JSON.stringify(result),
          timestamp,
          timestamp,
          clientOperationId,
          tenantId,
        ) as { changes: number | bigint }
        if (Number(completed.changes) !== 1) throw new Error('FISCAL_INTENT_NOT_READY')
      }
      return result
    })
  }

  private decorateReturn(row: any, tenantId: string): any {
    const items = this.db.prepare(`
      SELECT * FROM customer_return_items
      WHERE return_id = ? AND tenant_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC
    `).all(row.id, tenantId) as any[]
    return {
      id: row.id,
      sale_id: row.sale_id,
      customer_id: row.customer_id ?? null,
      return_type: row.return_type,
      reason: row.reason,
      reason_note: row.reason_note ?? null,
      refund_method: row.refund_method,
      refund_kopecks: Number(row.refund_kopecks ?? 0),
      stock_action: row.stock_action,
      status: row.status,
      approved_by: row.approved_by ?? 'local',
      created_at: row.created_at,
      fiscal_number: row.fiscal_number ?? null,
      sale: { id: row.sale_id, sale_number: row.sale_number, total: Number(row.sale_total ?? 0) },
      customer: row.customer_id ? {
        id: row.customer_id,
        phone: row.customer_phone ?? '',
        full_name: row.customer_name ?? null,
      } : null,
      return_items: items.map((item) => ({
        id: item.id,
        product_id: item.product_id,
        quantity: Number(item.quantity),
        unit_price_kopecks: Number(item.unit_price_kopecks),
        total_kopecks: Number(item.total_kopecks),
        condition: item.condition,
      })),
    }
  }
  private decorateSale(row: any, tenantId: string): any {
    const items = this.db.prepare(`
      SELECT si.*, p.name AS product_name, p.unit AS product_unit, p.qty_on_hand AS product_qty
      FROM sale_items si
      LEFT JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
      WHERE si.sale_id = ? AND si.tenant_id = ? AND si.deleted_at IS NULL
      ORDER BY si.created_at ASC
    `).all(row.id, tenantId) as any[]
    return {
      id: row.id,
      sale_number: row.sale_number,
      customer_id: row.customer_id ?? null,
      cashier_id: row.cashier_id,
      manager_id: row.manager_id ?? null,
      shift_id: row.shift_id,
      status: row.status,
      subtotal: Number(row.subtotal ?? 0),
      discount: Number(row.discount ?? 0),
      total: Number(row.total ?? 0),
      payment_method: row.payment_method,
      is_debt: row.is_debt === 1,
      notes: row.notes ?? null,
      completed_at: row.completed_at ?? row.created_at,
      is_fiscal: row.is_fiscal === 1,
      fiscal_number: row.fiscal_number ?? null,
      bank_auth_code: row.bank_auth_code ?? null,
      cash_amount: Number(row.cash_amount ?? 0),
      card_amount: Number(row.card_amount ?? 0),
      transfer_amount: Number(row.transfer_amount ?? 0),
      debt_amount: Number(row.debt_amount ?? 0),
      is_order_sale: row.is_order_sale === 1 || row.is_order_sale === true,
      pickup_cell: row.pickup_cell ?? null,
      customer: row.customer_id ? {
        id: row.customer_id,
        phone: row.customer_phone ?? '',
        full_name: row.customer_name ?? null,
      } : null,
      sale_items: items.map((item) => ({
        id: item.id,
        product_id: item.product_id,
        qty: Number(item.qty),
        unit_price: Number(item.unit_price),
        purchase_price: Number(item.purchase_price ?? 0),
        discount: Number(item.discount),
        total: Number(item.total),
        core_deposit_amount: Number(item.core_deposit_amount ?? 0),
        core_return_status: item.core_return_status ?? 'none',
        product: item.product_id ? {
          id: item.product_id,
          sku: item.sku ?? '',
          name: item.product_name ?? item.description ?? '',
          unit: item.product_unit ?? 'шт',
          qty_on_hand: Number(item.product_qty ?? 0),
        } : undefined,
      })),
      returns: [],
    }
  }
  private decorateCustomer(row: any): any {
    let tags: string[] = []
    try { tags = JSON.parse(row.tags_json ?? '[]') } catch { tags = [] }
    return {
      id: row.id,
      phone: row.phone ?? '',
      full_name: row.full_name ?? null,
      email: row.email ?? null,
      birth_date: row.birth_date ?? null,
      debt_balance: Number(row.debt_balance ?? 0),
      deposit_balance: Number(row.deposit_balance ?? 0),
      notes: row.notes ?? null,
      tags,
      price_tier_id: row.price_tier_id ?? null,
      price_tier: null,
      bonus_balance: Number(row.bonus_balance ?? 0),
      vip_level: row.vip_level ?? 'standard',
      risk_profile: row.risk_profile ?? 'low',
      discount_pct: Number(row.discount_pct ?? 0),
      client_status: row.client_status ?? 'client',
      card_barcode: row.card_barcode ?? null,
      primary_vin: row.primary_vin ?? null,
      car_count: Number(row.car_count ?? 0),
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at ?? null,
    }
  }

  private addCustomerVehicle(customerId: string, tenantId: string, vehicle: any, timestamp: string): boolean {
    if (!vehicle || !(vehicle.vin || vehicle.brand || vehicle.model)) return false
    const vin = String(vehicle.vin ?? '').trim().toUpperCase() || null
    if (vin) {
      const exists = this.db.prepare(`
        SELECT id FROM customer_vehicles
        WHERE tenant_id = ? AND customer_id = ? AND deleted_at IS NULL AND upper(vin) = ?
        LIMIT 1
      `).get(tenantId, customerId, vin)
      if (exists) return false
    }
    const id = randomUUID()
    const payload = {
      id,
      customer_id: customerId,
      brand: String(vehicle.brand ?? vehicle.make ?? '').trim(),
      model: String(vehicle.model ?? '').trim(),
      year: vehicle.year ?? null,
      vin,
      notes: vehicle.notes ?? null,
    }
    this.db.prepare(`
      INSERT INTO customer_vehicles (
        id, tenant_id, customer_id, brand, model, year, vin, notes,
        dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, tenantId, customerId, payload.brand, payload.model,
      payload.year, payload.vin, payload.notes, timestamp, timestamp, timestamp,
    )
    this.addOutbox(tenantId, 'customer_vehicle', id, 'customer_vehicle.created', payload, timestamp)
    return true
  }

  private markInterruptedFiscalIntentsUnknown(): void {
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE fiscal_sale_intents
      SET state = 'unknown',
          last_error = COALESCE(last_error, 'Роботу програми було перервано під час фіскалізації'),
          updated_at = ?
      WHERE state = 'fiscalizing'
    `).run(timestamp)
  }

  private checkoutIdentity(input: LocalSaleCheckoutInput, tenantId: string): Record<string, unknown> {
    return {
      tenant_id: tenantId,
      cashier_id: String(input.cashier_id ?? ''),
      shift_id: input.shift_id ?? null,
      customer_id: input.customer_id ?? null,
      manager_id: input.manager_id ?? null,
      notes: input.notes ?? null,
      discount: money(input.discount ?? 0),
      bonuses_spent: money(input.bonuses_spent ?? 0),
      is_fiscal: input.is_fiscal === true,
      items: input.items.map((item) => ({
        product_id: item.product_id ?? null,
        description: item.description ?? null,
        qty: Number(item.qty),
        unit_price: item.unit_price === undefined ? null : money(item.unit_price),
        discount: money(item.discount ?? 0),
      })),
      payments: input.payments.map((payment) => ({
        method: payment.method,
        amount: money(payment.amount),
        bank_auth_code: payment.bank_auth_code ?? null,
        terminal_rrn: payment.terminal_rrn ?? null,
      })),
    }
  }

  private checkoutPayloadHash(input: LocalSaleCheckoutInput, tenantId: string): string {
    return payloadHash(this.checkoutIdentity(input, tenantId))
  }

  private allowsNegativeStock(): boolean {
    const row = this.db.prepare(
      "SELECT value_json FROM app_meta WHERE key = 'shop_settings' LIMIT 1",
    ).get() as { value_json: string } | undefined
    if (!row?.value_json) return false
    try {
      return JSON.parse(row.value_json)?.allow_negative_qty === true
    } catch {
      return false
    }
  }

  private assertSaleStockAvailable(items: LocalSaleCheckoutInput['items'], tenantId: string): void {
    if (this.allowsNegativeStock()) return
    const requestedByProduct = new Map<string, number>()
    for (const item of items) {
      if (!item.product_id) continue
      requestedByProduct.set(
        item.product_id,
        (requestedByProduct.get(item.product_id) ?? 0) + Number(item.qty ?? 0),
      )
    }

    for (const [productId, requestedQty] of requestedByProduct) {
      const product = this.db.prepare(`
        SELECT id, name, qty_on_hand, is_service
        FROM products
        WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
        LIMIT 1
      `).get(productId, tenantId) as {
        id: string
        name: string
        qty_on_hand: number
        is_service: number
      } | undefined
      if (!product) throw new Error('LOCAL_PRODUCT_NOT_FOUND')
      if (product.is_service === 1) continue

      const reserve = this.db.prepare(`
        SELECT COALESCE(SUM(qty), 0) AS qty
        FROM stock_reserves
        WHERE tenant_id = ? AND product_id = ?
          AND released_at IS NULL AND deleted_at IS NULL
          AND (expires_at IS NULL OR strftime('%s', expires_at) > strftime('%s', 'now'))
      `).get(tenantId, productId) as { qty: number } | undefined
      const available = Number(product.qty_on_hand ?? 0) - Number(reserve?.qty ?? 0)
      if (requestedQty > available) {
        throw new Error(`Недостатньо товару «${product.name}». Доступно: ${available}, потрібно: ${requestedQty}`)
      }
    }
  }
  private assertCheckoutReady(input: LocalSaleCheckoutInput): {
    shift_id: string
    subtotal: number
    total: number
  } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    if (!Array.isArray(input.items) || input.items.length === 0) throw new Error('LOCAL_SALE_EMPTY')
    if (!Array.isArray(input.payments) || input.payments.length === 0) throw new Error('LOCAL_SALE_PAYMENT_REQUIRED')
    const shiftId = input.shift_id ?? this.findOpenShift(input.cashier_id, tenantId)
    if (!shiftId) throw new Error('LOCAL_OPEN_SHIFT_REQUIRED')
    const shift = this.db.prepare(`
      SELECT id FROM shifts
      WHERE id = ? AND tenant_id = ? AND status = 'open' AND deleted_at IS NULL
      LIMIT 1
    `).get(shiftId, tenantId)
    if (!shift) throw new Error('LOCAL_OPEN_SHIFT_REQUIRED')

    let subtotal = 0
    let itemDiscountTotal = 0
    for (const item of input.items) {
      if (!Number.isFinite(Number(item.qty)) || Number(item.qty) <= 0) {
        throw new Error('LOCAL_SALE_INVALID_QTY')
      }
      const product = item.product_id ? this.getProductForUpdate(item.product_id, tenantId) : null
      if (item.product_id && !product) throw new Error('LOCAL_PRODUCT_NOT_FOUND')
      const unitPrice = money(item.unit_price ?? product?.retail_price ?? 0)
      if (unitPrice <= 0) throw new Error('LOCAL_SALE_INVALID_PRICE')
      const gross = money(Number(item.qty) * unitPrice)
      const itemDiscount = Math.min(gross, money(item.discount ?? 0))
      const coreDepositAmount = product?.requires_core_return === 1
        ? money(product.core_deposit_amount ?? 0)
        : 0
      subtotal += gross + money(coreDepositAmount * Number(item.qty))
      itemDiscountTotal += itemDiscount
    }

    this.assertSaleStockAvailable(input.items, tenantId)
    const bonusesSpent = money(input.bonuses_spent ?? 0)
    if (bonusesSpent > 0 && !input.customer_id) {
      throw new Error('Для списання бонусів виберіть клієнта')
    }
    if (bonusesSpent > 0 && input.customer_id) {
      const customer = this.getCustomerForMoney(input.customer_id, tenantId)
      if (bonusesSpent > Number(customer.bonus_balance ?? 0)) {
        throw new Error('Недостатньо бонусів у клієнта')
      }
    }
    const total = Math.max(0, subtotal - itemDiscountTotal - money(input.discount ?? 0))
    const paidTotal = input.payments.reduce((sum, payment) => sum + money(payment.amount), 0)
    if (paidTotal !== total) throw new Error('LOCAL_SALE_PAYMENT_MISMATCH')
    return { shift_id: shiftId, subtotal, total }
  }

  private assertReturnReady(input: any): {
    tenant_id: string
    sale: any
    normalized: Array<{
      sale_item_id: string
      product_id: string
      quantity: number
      unit_price: number
      total: number
      condition: string
    }>
    refund: number
    approved_by: string
    shift_id: string | null
  } {
    const tenantId = input.tenant_id ?? DEFAULT_TENANT_ID
    const sale = this.getSale(input.sale_id, tenantId)
    const available = this.getSaleForReturn(input.sale_id, tenantId)
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new Error('Оберіть товар для повернення')
    }
    if (sale.status === 'returned' && !available.items.some((item: any) => item.available_qty > 0)) {
      throw new Error('Чек уже повністю повернуто')
    }
    const refundMethod = String(input.refund_method ?? 'cash')
    if (!['cash', 'terminal', 'debt_reduction', 'credit'].includes(refundMethod)) {
      throw new Error('Некоректний спосіб повернення')
    }
    if ((refundMethod === 'credit' || refundMethod === 'debt_reduction') && !sale.customer_id) {
      throw new Error('Цей спосіб повернення можливий лише для чека з клієнтом')
    }
    const stockAction = String(input.stock_action ?? 'return_to_stock')
    if (!['return_to_stock', 'write_off', 'send_to_supplier'].includes(stockAction)) {
      throw new Error('Некоректна дія з поверненим товаром')
    }
    const availableById = new Map(available.items.map((item: any) => [item.id, item]))
    const seen = new Set<string>()
    const normalized = input.items.map((item: any) => {
      const saleItemId = String(item.sale_item_id ?? '').trim()
      if (!saleItemId || seen.has(saleItemId)) {
        throw new Error('Одна позиція чека не може бути вказана двічі')
      }
      seen.add(saleItemId)
      const source = availableById.get(saleItemId) as any
      const productId = String(item.product_id ?? '').trim()
      const quantity = Number(item.quantity ?? 0)
      if (!source) {
        throw new Error('Позицію чека не знайдено')
      }
      if (!productId || source.product_id !== productId) {
        throw new Error('Товар не відповідає позиції чека')
      }
      if (
        !Number.isFinite(quantity)
        || quantity <= 0
        || quantity > Number(source.available_qty) + Number.EPSILON
      ) {
        throw new Error(`Для ${source.product_name} доступно до повернення: ${source.available_qty}`)
      }
      const condition = String(item.condition ?? 'good')
      if (
        !['good', 'damaged', 'opened_packaging', 'defective'].includes(condition)
        || (condition === 'defective' && stockAction === 'return_to_stock')
      ) {
        throw new Error('Стан товару не відповідає вибраній дії')
      }
      const remainingRefund = Math.max(
        0,
        Number(source.refundable_total) - Number(source.already_refunded_kopecks),
      )
      const isFinalQuantity = quantity >= Number(source.available_qty) - Number.EPSILON
      const total = isFinalQuantity
        ? remainingRefund
        : Math.min(
            remainingRefund,
            money(Number(source.refundable_total) * quantity / Number(source.qty)),
          )
      return {
        sale_item_id: source.id,
        product_id: source.product_id,
        quantity,
        unit_price: Number(source.unit_price),
        total,
        condition,
      }
    })
    const refund = normalized.reduce((sum: number, item: any) => sum + item.total, 0)
    const approvedBy = input.approved_by ?? sale.cashier_id ?? 'local'
    const shiftId = input.shift_id ?? this.findOpenShift(approvedBy, tenantId) ?? null
    if (refundMethod === 'credit' || refundMethod === 'debt_reduction') {
      const customer = this.getCustomerForMoney(sale.customer_id, tenantId)
      if (refundMethod === 'debt_reduction' && Number(customer.debt_balance ?? 0) < refund) {
        throw new Error('Сума боргу клієнта менша за суму повернення')
      }
    }
    if (refundMethod === 'cash') {
      if (!shiftId) throw new Error('Для повернення готівки потрібна відкрита касова зміна')
      const openShift = this.db.prepare(`
        SELECT id FROM shifts
        WHERE id = ? AND tenant_id = ? AND cashier_id = ?
          AND status = 'open' AND deleted_at IS NULL
        LIMIT 1
      `).get(shiftId, tenantId, approvedBy)
      if (!openShift) throw new Error('Касова зміна для повернення вже закрита')
      const expectedCash = this.getExpectedCash(approvedBy, tenantId)?.expected_amount ?? 0
      if (expectedCash < refund) {
        throw new Error(`У касі недостатньо готівки. Доступно ${(expectedCash / 100).toFixed(2)} грн, потрібно ${(refund / 100).toFixed(2)} грн`)
      }
    }
    return {
      tenant_id: tenantId,
      sale,
      normalized,
      refund,
      approved_by: approvedBy,
      shift_id: shiftId,
    }
  }

  private returnIdentity(input: any, tenantId: string): Record<string, unknown> {
    return {
      tenant_id: tenantId,
      sale_id: String(input.sale_id ?? ''),
      approved_by: input.approved_by ?? null,
      shift_id: input.shift_id ?? null,
      reason: String(input.reason ?? 'other'),
      reason_note: input.reason_note ?? null,
      refund_method: String(input.refund_method ?? 'cash'),
      stock_action: String(input.stock_action ?? 'return_to_stock'),
      is_fiscal: input.is_fiscal === true,
      items: Array.isArray(input.items)
        ? input.items.map((item: any) => ({
            sale_item_id: item.sale_item_id ?? null,
            product_id: item.product_id ?? null,
            quantity: Number(item.quantity),
            condition: String(item.condition ?? 'good'),
          }))
        : [],
    }
  }

  private returnPayloadHash(input: any, tenantId: string): string {
    return payloadHash(this.returnIdentity(input, tenantId))
  }

  private existingReturnResult(tenantId: string, id: string, expectedHash: string): any | null {
    const row = this.db.prepare(`
      SELECT id, client_payload_hash
      FROM customer_returns
      WHERE tenant_id = ? AND client_operation_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(tenantId, id) as { id: string; client_payload_hash: string | null } | undefined
    if (!row) return null
    if (row.client_payload_hash !== expectedHash) {
      throw new Error('LOCAL_RETURN_OPERATION_CONFLICT|Цей номер операції вже використано для іншого повернення')
    }
    return this.getReturn(row.id, tenantId)
  }

  private assertFiscalIntentCanReturn(
    id: string,
    returnHash: string,
    fiscalNumber: string | null | undefined,
  ): FiscalIntentRow {
    const intent = this.requireFiscalIntentRow(id)
    if (intent.operation_kind !== 'return' || intent.checkout_hash !== returnHash) {
      throw new Error('FISCAL_INTENT_CONFLICT|Дані повернення відрізняються від підготовленої операції')
    }
    if (intent.state === 'fiscalizing' || intent.state === 'unknown') {
      throw new Error(`FISCAL_INTENT_UNKNOWN|${id}|Результат фіскального повернення потрібно перевірити у ПРРО`)
    }
    if (intent.state === 'prepared') {
      throw new Error('Фіскальне повернення ще не зареєстровано')
    }
    if (intent.state === 'completed') {
      throw new Error('Завершене фіскальне повернення не знайдено у локальній базі')
    }
    if (intent.fiscal_number && intent.fiscal_number !== (fiscalNumber ?? null)) {
      throw new Error('FISCAL_INTENT_CONFLICT|Фіскальний номер повернення не відповідає результату ПРРО')
    }
    return intent
  }

  private getFiscalIntentRow(id: string): FiscalIntentRow | null {
    return (this.db.prepare(`
      SELECT operation_kind, operation_id, tenant_id, cashier_id, state,
             payload_hash, checkout_hash, checkout_json, fiscal_items_json,
             fiscal_pay_json, fiscal_comment, fiscal_result_json,
             checkout_result_json, last_error, fiscal_number, created_at, updated_at
      FROM fiscal_sale_intents
      WHERE operation_id = ?
      LIMIT 1
    `).get(id) as FiscalIntentRow | undefined) ?? null
  }

  private requireFiscalIntentRow(id: string): FiscalIntentRow {
    const row = this.getFiscalIntentRow(id)
    if (!row) throw new Error('Фіскальну операцію каси не знайдено')
    return row
  }

  private requireScopedFiscalReturnIntent(
    idValue: string,
    scope: LocalFiscalReturnIntentScope,
  ): FiscalIntentRow {
    const id = operationId(idValue)
    if (!id) throw new Error('Номер операції каси не вказано')
    const tenantId = scope.tenant_id ?? DEFAULT_TENANT_ID
    const cashierId = String(scope.cashier_id ?? '').trim()
    if (!cashierId) throw new Error('Не вказано касира')
    const row = this.getFiscalIntentRow(id)
    if (
      !row
      || row.operation_kind !== 'return'
      || row.tenant_id !== tenantId
      || row.cashier_id !== cashierId
    ) {
      throw new Error('Незавершене повернення цього касира не знайдено')
    }
    return row
  }

  private parseFiscalIntentJson<T>(value: string, errorMessage: string): T {
    try {
      const parsed = JSON.parse(value) as T
      if (parsed === null || parsed === undefined) throw new Error(errorMessage)
      return parsed
    } catch {
      throw new Error(errorMessage)
    }
  }

  private fiscalIntentResult(row: FiscalIntentRow): LocalFiscalSaleIntentResult {
    const parse = (value: string | null): any => {
      if (!value) return null
      try { return JSON.parse(value) } catch { return null }
    }
    return {
      operation_id: row.operation_id,
      state: row.state,
      payload_hash: row.payload_hash,
      fiscal_result: parse(row.fiscal_result_json),
      checkout_result: parse(row.checkout_result_json),
      last_error: row.last_error ?? null,
    }
  }

  private existingCheckoutResult(
    tenantId: string,
    id: string,
    expectedHash: string,
  ): LocalSaleCheckoutResult | null {
    const row = this.db.prepare(`
      SELECT s.id AS sale_id, s.sale_number, s.total, s.subtotal, s.payment_method,
             s.client_payload_hash,
             COALESCE((
               SELECT o.sequence
               FROM sync_outbox o
               WHERE o.tenant_id = s.tenant_id
                 AND o.aggregate_type = 'sale'
                 AND o.aggregate_id = s.id
                 AND o.operation_type = 'sale.completed'
               ORDER BY o.sequence DESC
               LIMIT 1
             ), 0) AS outbox_sequence
      FROM sales s
      WHERE s.tenant_id = ? AND s.client_operation_id = ? AND s.deleted_at IS NULL
      LIMIT 1
    `).get(tenantId, id) as (LocalSaleCheckoutResult & { client_payload_hash: string | null }) | undefined
    if (!row) return null
    if (row.client_payload_hash !== expectedHash) {
      throw new Error('LOCAL_PAYMENT_OPERATION_CONFLICT|Цей номер операції вже використано для іншого чека')
    }
    return {
      sale_id: row.sale_id,
      sale_number: row.sale_number,
      total: Number(row.total),
      subtotal: Number(row.subtotal),
      payment_method: row.payment_method,
      outbox_sequence: row.outbox_sequence,
    }
  }

  private assertFiscalIntentCanCheckout(
    id: string,
    checkoutHash: string,
    fiscalNumber: string | null | undefined,
  ): FiscalIntentRow {
    const intent = this.requireFiscalIntentRow(id)
    if (intent.checkout_hash !== checkoutHash) {
      throw new Error('FISCAL_INTENT_CONFLICT|Дані чека відрізняються від підготовленої операції')
    }
    if (intent.state === 'fiscalizing' || intent.state === 'unknown') {
      throw new Error(`FISCAL_INTENT_UNKNOWN|${id}|Результат фіскалізації потрібно перевірити у ПРРО`)
    }
    if (intent.state === 'prepared') {
      throw new Error('Фіскальний чек ще не зареєстровано')
    }
    if (intent.state === 'completed') {
      throw new Error('Завершений фіскальний чек не знайдено у продажах')
    }
    if (intent.fiscal_number && intent.fiscal_number !== (fiscalNumber ?? null)) {
      throw new Error('FISCAL_INTENT_CONFLICT|Фіскальний номер не відповідає результату ПРРО')
    }
    return intent
  }

  private nextSaleNumber(tenantId: string, timestamp: string): string {
    const date = dayStamp(new Date(timestamp))
    const device = this.db.deviceId.replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase().padEnd(4, '0')
    const scope = `${tenantId}:sale:${date}:${device}`
    const row = this.db.prepare(`
      INSERT INTO local_sequences(scope, value, updated_at)
      VALUES (?, 1, ?)
      ON CONFLICT(scope) DO UPDATE SET
        value = value + 1,
        updated_at = excluded.updated_at
      RETURNING value
    `).get(scope, timestamp) as { value: number } | undefined

    return `L-${date.slice(2)}-${device}-${String(row?.value ?? 1).padStart(4, '0')}`
  }

  private getProductForUpdate(productId: string, tenantId: string): LocalProduct | null {
    const row = this.db.prepare(`
      SELECT id, tenant_id, sku, name, barcode, unit, purchase_price, retail_price,
             qty_on_hand, is_active, is_service, storage_bin
      FROM products
      WHERE id = ?
        AND tenant_id = ?
        AND deleted_at IS NULL
        AND is_active = 1
    `).get(productId, tenantId) as LocalProduct | undefined
    return row ?? null
  }

  private summarizePayments(payments: LocalSalePaymentInput[]): {
    cash: number
    card: number
    transfer: number
    debt: number
  } {
    return payments.reduce((acc, payment) => {
      acc[payment.method] += money(payment.amount)
      return acc
    }, { cash: 0, card: 0, transfer: 0, debt: 0 })
  }

  private getCustomerForMoney(customerId: string, tenantId: string): {
    id: string
    full_name: string | null
    phone: string | null
    debt_balance: number
    deposit_balance: number
    bonus_balance: number
    loyalty_mode: 'discount' | 'cashback'
    discount_pct: number
  } {
    const row = this.db.prepare(`
      SELECT id, full_name, phone, debt_balance, COALESCE(deposit_balance, 0) AS deposit_balance,
             COALESCE(bonus_balance, 0) AS bonus_balance, COALESCE(loyalty_mode, 'discount') AS loyalty_mode,
             COALESCE(discount_pct, 0) AS discount_pct
      FROM customers
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(customerId, tenantId) as { id: string; full_name: string | null; phone: string | null; debt_balance: number; deposit_balance: number; bonus_balance: number; loyalty_mode: 'discount' | 'cashback'; discount_pct: number } | undefined
    if (!row) throw new Error('Клієнта не знайдено')
    return row
  }

  private addCashOperation(
    tenantId: string,
    shiftId: string | null,
    userId: string | null,
    type: 'cash_in' | 'cash_out' | 'return_cash',
    amount: number,
    notes: string,
    timestamp: string,
    operationId = randomUUID(),
  ): void {
    this.db.prepare(`
      INSERT INTO cash_operations (
        id, tenant_id, shift_id, user_id, type, source, amount, notes,
        dirty_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'cashbox', ?, ?, ?, ?, ?)
    `).run(operationId, tenantId, shiftId, userId, type, amount, notes, timestamp, timestamp, timestamp)
  }
  private addOutbox(
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
    operationType: string,
    payload: unknown,
    timestamp: string,
  ): number | bigint {
    const result = this.db.prepare(`
      INSERT INTO sync_outbox (
        operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      randomUUID(),
      tenantId,
      this.db.deviceId,
      aggregateType,
      aggregateId,
      operationType,
      JSON.stringify(payload),
      timestamp,
    ) as { lastInsertRowid: number | bigint }
    return result.lastInsertRowid
  }

  private addAudit(
    tenantId: string,
    userId: string,
    action: string,
    entityType: string,
    entityId: string,
    after: unknown,
    timestamp: string,
    operationId = randomUUID(),
  ): void {
    this.db.prepare(`
      INSERT INTO audit_log (
        event_id, tenant_id, device_id, user_id, action, entity_type, entity_id,
        after_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      tenantId,
      this.db.deviceId,
      userId,
      action,
      entityType,
      entityId,
      JSON.stringify(after),
      timestamp,
    )
  }
}
