import type { SupplyInvoice } from '@/types/supplier'
// Mirror the local repository rules; a visible action must be legal for this document.
export function invoiceActions(invoice: Pick<SupplyInvoice, 'status' | 'paid_amount' | 'total'> | null, role?: string) {
  const paid = Number(invoice?.paid_amount ?? 0)
  const cancelled = invoice?.status === 'cancelled'
  const debt = !invoice || cancelled ? 0 : Math.max(0, invoice.total - paid)
  const canReceive = ['owner', 'admin', 'manager', 'cashier', 'storekeeper'].includes(role ?? '')
  const canReverse = ['owner', 'admin', 'manager', 'storekeeper'].includes(role ?? '')
  return {
    debt, cancelled,
    canDelete: !!invoice && invoice.status === 'draft' && paid <= 0 && ['owner', 'admin'].includes(role ?? ''),
    canPay: !!invoice && !cancelled && debt > 0 && canReceive,
    canPost: invoice?.status === 'draft' && canReceive,
    canCancel: invoice?.status === 'posted' && paid <= 0 && canReverse,
  }
}
export function invoiceActionError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : ''
  return message.replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, '').replace(/^Error:\s*/i, '').trim() || fallback
}
