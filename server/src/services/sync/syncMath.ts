/**
 * Винесено з `syncService.ts` без зміни поведінки — див. `REFACTOR_PLAN.md`,
 * ітерація 4. У файлі на 4900 рядків помилку не видно очима.
 */

import { AppError } from '../../middleware/errorHandler.js'
import { checkedSyncMoney } from '../syncMoney.js'

export function invoiceLineTotal(item: any): number {
  const itemQty = Number(item?.qty ?? 0)
  if (!Number.isFinite(itemQty) || itemQty <= 0) {
    throw new AppError('SYNC_INVOICE_ITEM_INVALID', 'Некоректна кількість у накладній', 422)
  }
  try {
    const purchasePrice = checkedSyncMoney(item?.purchase_price ?? 0, 'Ціна закупівлі')
    return checkedSyncMoney(itemQty * purchasePrice, 'Сума позиції накладної')
  } catch (error: any) {
    throw new AppError('SYNC_INVOICE_ITEM_INVALID', error?.message ?? 'Некоректна ціна у накладній', 422)
  }
}

export function normalizePaymentMethod(value: unknown): 'cash' | 'card' | 'debt' | 'mixed' | 'transfer' {
  return value === 'cash' || value === 'card' || value === 'debt' || value === 'mixed' || value === 'transfer'
    ? value
    : 'cash'
}

export function sumPayments(payments: any[], method: string): number {
  return payments
    .filter((payment) => payment?.method === method)
    .reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0)
}
