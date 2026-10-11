import type { LocalFiscalReturnRequest, LocalFiscalSaleRequest } from '../db/localTypes'
import type { LocalPosRepository } from '../repositories/posRepository'
import type { CashalotService } from './cashalotService'
import { cashalotReceiptNumber } from './cashalotReceipt'

type FiscalPos = Pick<LocalPosRepository,
  | 'prepareFiscalSaleIntent' | 'prepareFiscalReturnIntent' | 'startFiscalSaleIntent'
  | 'markFiscalSaleIntentFiscalized' | 'markFiscalSaleIntentUnknown'
  | 'getFiscalSaleIntent' | 'createReturn'
>
type FiscalService = Pick<CashalotService, 'isEnabled' | 'fiscalizeCheck' | 'fiscalizeReturnCheck'>

// Keep the service lookup lazy: an existing/uncertain intent must be recoverable
// or blocked without first requiring an available external fiscal service.
export async function fiscalizeSale(
  pos: FiscalPos,
  getCashalot: () => FiscalService,
  request: LocalFiscalSaleRequest,
) {
  const intent = pos.prepareFiscalSaleIntent(request)
  if (intent.state === 'completed' || intent.state === 'fiscalized') return intent
  if (intent.state === 'fiscalizing' || intent.state === 'unknown') {
    throw new Error(
      `FISCAL_INTENT_UNKNOWN|${intent.operation_id}|Результат попередньої фіскалізації потрібно перевірити у Cashalot`,
    )
  }

  const fiscal = getCashalot()
  if (!fiscal.isEnabled()) {
    throw new Error('ПРРО Cashalot не налаштовано або вимкнено')
  }

  pos.startFiscalSaleIntent(intent.operation_id)
  try {
    const result = await fiscal.fiscalizeCheck(request.items, request.pay, request.comment)
    return pos.markFiscalSaleIntentFiscalized(
      intent.operation_id,
      result as unknown as Record<string, unknown>,
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    try {
      pos.markFiscalSaleIntentUnknown(intent.operation_id, detail)
    } catch {
      // Намір уже залишився у безпечному блокувальному стані fiscalizing/unknown.
    }
    throw new Error(
      `FISCAL_INTENT_UNKNOWN|${intent.operation_id}|Не повторюйте оплату. Перевірте чек у Cashalot: ${detail}`,
    )
  }
}

export async function processFiscalReturn(
  pos: FiscalPos,
  getCashalot: () => FiscalService,
  request: LocalFiscalReturnRequest,
) {
  let intent = pos.prepareFiscalReturnIntent(request)
  if (intent.state === 'completed') {
    return { intent, data: intent.checkout_result }
  }
  if (intent.state === 'fiscalizing' || intent.state === 'unknown') {
    throw new Error(
      `FISCAL_INTENT_UNKNOWN|${intent.operation_id}|Результат попереднього фіскального повернення потрібно перевірити у Cashalot`,
    )
  }

  if (intent.state === 'prepared') {
    const fiscal = getCashalot()
    if (!fiscal.isEnabled()) {
      throw new Error('ПРРО Cashalot не налаштовано або вимкнено')
    }
    pos.startFiscalSaleIntent(intent.operation_id)
    try {
      const result = await fiscal.fiscalizeReturnCheck(
        request.items,
        request.pay,
        request.original_fiscal_number,
      )
      intent = pos.markFiscalSaleIntentFiscalized(
        intent.operation_id,
        result as unknown as Record<string, unknown>,
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      try {
        pos.markFiscalSaleIntentUnknown(intent.operation_id, detail)
      } catch {
        // Намір уже залишився у безпечному блокувальному стані fiscalizing/unknown.
      }
      throw new Error(
        `FISCAL_INTENT_UNKNOWN|${intent.operation_id}|Не повторюйте повернення. Перевірте чек у Cashalot: ${detail}`,
      )
    }
  }

  const fiscalResult = intent.fiscal_result
  if (!fiscalResult) {
    throw new Error(
      `FISCAL_INTENT_UNKNOWN|${intent.operation_id}|Збережений результат фіскального повернення не знайдено`,
    )
  }
  const fiscalNumber = cashalotReceiptNumber(fiscalResult)
  const data = pos.createReturn({
    ...request.return_input,
    client_operation_id: intent.operation_id,
    is_fiscal: true,
    fiscal_number: fiscalNumber,
  })
  return {
    intent: pos.getFiscalSaleIntent(intent.operation_id),
    data,
  }
}
