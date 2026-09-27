import type { OpenReceiptSnapshot, POSCustomer, POSItem, usePOSStore } from '@/stores/posStore'

type ReceiptStore = Pick<typeof usePOSStore, 'getState' | 'subscribe'>
type CartStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
interface OpenReceipts {
  tabs: OpenReceiptSnapshot[]
  activeOperationId: string | null
  managerId: string | null
  shiftId: string | null
}
const LEGACY_KEY = 'forsage_pos_cart'
export const openReceiptsKey = (scope: string) => 'forsage_pos_open_receipts_v2:' + encodeURIComponent(scope)
const hydratedScopes = new WeakMap<ReceiptStore, string>()
const operationId = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/.test(value.trim())
  ? value.trim() : crypto.randomUUID()
const textId = (value: unknown) => typeof value === 'string' && value ? value : null
const nonnegative = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0

export function parseOpenReceipts(raw: string | null): OpenReceipts | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.tabs)) return null
    const seen = new Set<string>()
    const tabs: OpenReceiptSnapshot[] = parsed.tabs.slice(0, 5).flatMap((tab: any) => {
      if (!tab || !Array.isArray(tab.items)) return []
      const idempotencyKey = operationId(tab.idempotencyKey)
      if (seen.has(idempotencyKey)) return []
      seen.add(idempotencyKey)
      const items: POSItem[] = tab.items.flatMap((item: any) => {
        if (!item || !item.productId) return []
        const qty = Number(item.qty), unitPrice = Number(item.unitPrice)
        if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) return []
        const discount = Math.max(0, Math.min(Number(item.discount) || 0, qty * unitPrice))
        return [{ productId: String(item.productId), sku: String(item.sku ?? ''),
          name: String(item.name ?? item.sku ?? 'Товар'), unit: String(item.unit ?? 'шт'),
          qty, unitPrice, discount, total: qty * unitPrice - discount,
          discountPct: Number.isFinite(item.discountPct) ? Math.max(0, Math.min(100, item.discountPct)) : undefined,
          qtyOnHand: Number(item.qtyOnHand) || 0, requiresCoreReturn: item.requiresCoreReturn === true,
          coreDepositAmount: Number.isFinite(item.coreDepositAmount) ? nonnegative(item.coreDepositAmount) : 0,
          photoUrl: typeof item.photoUrl === 'string' ? item.photoUrl : null }]
      })
      const customer: POSCustomer | null = tab.customer && typeof tab.customer.id === 'string'
        ? { ...tab.customer, phone: String(tab.customer.phone ?? ''), name: textId(tab.customer.name),
          debtBalance: Number(tab.customer.debtBalance) || 0,
          tierDiscountPct: Math.min(100, nonnegative(tab.customer.tierDiscountPct)) } : null
      return [{ idempotencyKey, items, customer, notes: String(tab.notes ?? ''),
        bonusToRedeem: Number.isFinite(tab.bonusToRedeem) ? nonnegative(tab.bonusToRedeem) : 0,
        customerOrderId: textId(tab.customerOrderId),
        automaticDiscountPct: Math.min(100, nonnegative(tab.automaticDiscountPct)) }]
    })
    return { tabs, activeOperationId: textId(parsed.activeOperationId),
      managerId: textId(parsed.managerId), shiftId: textId(parsed.shiftId) }
  } catch { return null }
}

/** One live set of open receipts. The disk snapshot is never a second set to offer in a banner. */
export function connectOpenReceipts(store: ReceiptStore, storage: CartStorage, scope: string): (() => void) & { flush: () => void } {
  const key = openReceiptsKey(scope)
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    if (hydratedScopes.get(store) !== scope) return
    clearTimeout(timer)
    const state = store.getState()
    const snapshot: OpenReceipts = {
      tabs: state.tabs.map(({ idempotencyKey, items, customer, notes, bonusToRedeem, customerOrderId, automaticDiscountPct }) =>
        ({ idempotencyKey, items, customer, notes, bonusToRedeem, customerOrderId, automaticDiscountPct })),
      activeOperationId: state.getActiveTab()?.idempotencyKey ?? null,
      shiftId: state.currentShift?.id ?? null,
      managerId: state.managerId,
    }
    try { storage.setItem(key, JSON.stringify(snapshot)) }
    catch (error) { console.warn('Не вдалося зберегти відкриті чеки', error) }
  }
  const previousScope = hydratedScopes.get(store)
  if (previousScope !== scope) {
    let saved: OpenReceipts | null = null
    let migrateLegacy = false
    try {
      const raw = storage.getItem(key)
      saved = parseOpenReceipts(raw)
      // Old snapshots had no cashier identity. Claim only the currently verified shift.
      if (!raw) {
        const legacy = parseOpenReceipts(storage.getItem(LEGACY_KEY))
        if (legacy?.shiftId && legacy.shiftId === store.getState().currentShift?.id) {
          saved = legacy
          migrateLegacy = true
        }
      }
    } catch (error) { console.warn('Не вдалося прочитати відкриті чеки', error) }
    const hasLiveReceipt = store.getState().tabs.some(tab => tab.items.length || tab.customer || tab.notes || tab.customerOrderId)
    if (previousScope !== undefined || !hasLiveReceipt) {
      store.getState().replaceOpenReceipts(saved?.tabs ?? [], saved?.activeOperationId)
      store.getState().setManagerId(saved?.managerId ?? null)
    }
    hydratedScopes.set(store, scope)
    flush()
    if (migrateLegacy && (previousScope !== undefined || !hasLiveReceipt)) {
      // Remove the legacy snapshot only after its replacement was durably written.
      try { if (storage.getItem(key)) storage.removeItem(LEGACY_KEY) } catch { /* keep backup on storage failure */ }
    }
  }
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.tabs === previous.tabs && state.activeTabId === previous.activeTabId &&
        state.managerId === previous.managerId && state.currentShift === previous.currentShift) return
    clearTimeout(timer)
    // Deletions, checkout and tab closing must never survive as an older disk copy.
    const removed = previous.tabs.some(old => {
      const next = state.tabs.find(tab => tab.idempotencyKey === old.idempotencyKey)
      return !next || old.items.some(item => !next.items.some(candidate => candidate.productId === item.productId))
    })
    if (removed) flush()
    else timer = setTimeout(flush, 180)
  })
  let disconnected = false
  return Object.assign(() => {
    if (disconnected) return
    disconnected = true
    unsubscribe()
    flush()
  }, { flush })
}
