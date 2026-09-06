/**
 * ПРРО: наміри фіскальних чеків і повернень, їх стан і розвʼязання.
 *
 * Частина каси, винесена з `posRepository.ts` (3431 рядок) — див.
 * `REFACTOR_PLAN.md`, ітерація 4. Клас поділено ланцюжком успадкування:
 * кожен шар кличе лише те, що лежить нижче, тому жоден виклик `this.` не
 * довелося переписувати. Методи перенесені рядок у рядок.
 */
import type { LocalFiscalIntentResolution, LocalFiscalReturnIntentCancelInput, LocalFiscalReturnIntentResolution, LocalFiscalReturnIntentScope, LocalFiscalReturnRequest, LocalFiscalSaleIntentResult, LocalFiscalSaleIntentState, LocalFiscalSaleRequest, LocalSaleCheckoutInput, LocalUnresolvedFiscalReturnIntent } from '../../db/localTypes'
import { DEFAULT_TENANT_ID } from '../../db/localTypes'
import type { FiscalIntentRow } from './posShared'
import { money, nowIso, operationId, payloadHash } from './posShared'
import { LocalPosReturns } from './returns'

export class LocalPosFiscal extends LocalPosReturns {
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

  protected markInterruptedFiscalIntentsUnknown(): void {
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE fiscal_sale_intents
      SET state = 'unknown',
          last_error = COALESCE(last_error, 'Роботу програми було перервано під час фіскалізації'),
          updated_at = ?
      WHERE state = 'fiscalizing'
    `).run(timestamp)
  }
}
