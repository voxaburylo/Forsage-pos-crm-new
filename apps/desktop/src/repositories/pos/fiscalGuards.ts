/**
 * Перевірки фіскального наміру — потрібні і чеку, і поверненню, тому лежать нижче за обох.
 *
 * Частина каси, винесена з `posRepository.ts` (3431 рядок) — див.
 * `REFACTOR_PLAN.md`, ітерація 4. Клас поділено ланцюжком успадкування:
 * кожен шар кличе лише те, що лежить нижче, тому жоден виклик `this.` не
 * довелося переписувати. Методи перенесені рядок у рядок.
 */
import type { LocalFiscalReturnIntentScope, LocalFiscalSaleIntentResult } from '../../db/localTypes'
import { DEFAULT_TENANT_ID } from '../../db/localTypes'
import type { FiscalIntentRow } from './posShared'
import { operationId } from './posShared'
import { LocalPosBase } from './base'

export class LocalPosFiscalGuards extends LocalPosBase {
  protected assertFiscalIntentCanReturn(
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

  protected getFiscalIntentRow(id: string): FiscalIntentRow | null {
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

  protected requireFiscalIntentRow(id: string): FiscalIntentRow {
    const row = this.getFiscalIntentRow(id)
    if (!row) throw new Error('Фіскальну операцію каси не знайдено')
    return row
  }

  protected requireScopedFiscalReturnIntent(
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

  protected fiscalIntentResult(row: FiscalIntentRow): LocalFiscalSaleIntentResult {
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

  protected assertFiscalIntentCanCheckout(
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

  protected parseFiscalIntentJson<T>(value: string, errorMessage: string): T {
    try {
      const parsed = JSON.parse(value) as T
      if (parsed === null || parsed === undefined) throw new Error(errorMessage)
      return parsed
    } catch {
      throw new Error(errorMessage)
    }
  }
}
