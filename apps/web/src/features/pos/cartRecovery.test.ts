import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { usePOSStore, type OpenReceiptSnapshot } from '@/stores/posStore'
import { connectOpenReceipts, openReceiptsKey, parseOpenReceipts } from './cartRecovery'

const item = { productId: 'product-1', sku: 'SKU1', name: 'Фільтр', unit: 'шт', qty: 2,
  unitPrice: 5000, discount: 0, total: 10000, qtyOnHand: 8 }
const receipt = (key = 'operation-0001'): OpenReceiptSnapshot => ({ idempotencyKey: key,
  items: [{ ...item }], customer: null, notes: '', bonusToRedeem: 0, customerOrderId: null, automaticDiscountPct: 0 })
function memoryStorage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) } }
}
let storage: ReturnType<typeof memoryStorage>
let store: Pick<typeof usePOSStore, 'getState' | 'subscribe'>
let cleanup: Array<() => void>
const scope = 'local:cashier-one'
const saved = () => parseOpenReceipts(storage.getItem(openReceiptsKey(scope)))!
function connect(owner = scope) {
  const stop = connectOpenReceipts(store, storage, owner)
  cleanup.push(stop)
  return stop
}
function seed(tabs = [receipt()], activeOperationId = tabs[0]?.idempotencyKey) {
  storage.setItem(openReceiptsKey(scope), JSON.stringify({ tabs, activeOperationId, shiftId: 'shift-one' }))
}
beforeEach(() => {
  vi.useFakeTimers()
  usePOSStore.getState().replaceOpenReceipts([])
  usePOSStore.setState({ currentShift: { id: 'shift-one' } as any, managerId: null })
  storage = memoryStorage()
  store = { getState: usePOSStore.getState, subscribe: usePOSStore.subscribe }
  cleanup = []
})
afterEach(() => { cleanup.forEach(stop => stop()); vi.useRealTimers() })

describe('one authoritative set of open POS receipts', () => {
  it('loads an open receipt automatically, preserving its payment operation ID', () => {
    seed(); connect()
    expect(store.getState().items).toMatchObject([item])
    expect(store.getState().getActiveTab()?.idempotencyKey).toBe('operation-0001')
  })
  it('navigation keeps the current edits and does not import a stale copy again', () => {
    seed(); const leave = connect()
    store.getState().updateQty(item.productId, 4)
    leave()
    seed() // simulate an obsolete snapshot; live state wins for this session
    connect()
    expect(store.getState().items[0].qty).toBe(4)
    expect(store.getState().tabs).toHaveLength(1)
  })
  it('flushes a scan immediately on navigation before the debounce has elapsed', () => {
    const leave = connect()
    store.getState().addItem(item)
    leave()
    expect(saved().tabs[0].items).toMatchObject([item])
  })
  it('deletes the final product from disk immediately and never resurrects it', () => {
    seed(); const leave = connect()
    store.getState().removeItem(item.productId)
    expect(saved().tabs.flatMap(tab => tab.items)).toEqual([])
    leave(); connect()
    expect(store.getState().items).toEqual([])
  })
  it('deleting one item keeps the other item and updates disk without waiting', () => {
    seed(); connect()
    store.getState().addItem({ ...item, productId: 'product-2' })
    store.getState().removeItem(item.productId)
    expect(saved().tabs[0].items.map(row => row.productId)).toEqual(['product-2'])
  })
  it('checkout/closing one receipt never erases another unpaid receipt', () => {
    seed([receipt(), receipt('operation-0002')]); connect()
    store.getState().clearReceipt()
    expect(saved().tabs.map(tab => tab.idempotencyKey)).toEqual(['operation-0002'])
    expect(store.getState().items).toHaveLength(1)
  })
  it('a reset persists an empty receipt even when an old legacy snapshot exists', () => {
    seed(); connect()
    storage.setItem('forsage_pos_cart', JSON.stringify({ tabs: [receipt()], shiftId: 'shift-one' }))
    store.getState().clearReceipt()
    expect(saved().tabs[0].items).toEqual([])
    expect(saved().tabs[0].idempotencyKey).not.toBe('operation-0001')
    const fresh = { getState: store.getState, subscribe: store.subscribe }
    cleanup.push(connectOpenReceipts(fresh, storage, scope))
    expect(store.getState().items).toEqual([])
  })
  it('keeps five tabs, distinct identical products, and the selected tab', () => {
    const tabs = Array.from({ length: 5 }, (_, i) => receipt('operation-000' + i))
    seed(tabs, 'operation-0003'); connect()
    expect(store.getState().tabs).toHaveLength(5)
    expect(store.getState().getActiveTab()?.idempotencyKey).toBe('operation-0003')
  })
  it('retains customer, order, bonuses, discount, notes and photo across restart', () => {
    const tab = receipt()
    tab.customer = { id: 'client', phone: '123', name: 'Клієнт', debtBalance: 0, tierDiscountPct: 5,
      tierName: 'Постійний', vipLevel: 'standard', riskProfile: 'low' }
    tab.notes = 'Не телефонувати'; tab.bonusToRedeem = 100; tab.customerOrderId = 'order'
    tab.automaticDiscountPct = 5; tab.items[0].photoUrl = 'https://example.invalid/photo.jpg'
    seed([tab]); connect()
    expect(store.getState().getActiveTab()).toMatchObject(tab)
  })
  it('migrates the current shift legacy snapshot once with no restore banner', () => {
    storage.setItem('forsage_pos_cart', JSON.stringify({ tabs: [receipt()], shiftId: 'shift-one' }))
    const leave = connect()
    expect(store.getState().items).toHaveLength(1)
    expect(storage.getItem('forsage_pos_cart')).toBeNull()
    leave(); connect()
    expect(store.getState().tabs).toHaveLength(1)
  })
  it('does not claim an unscoped legacy snapshot belonging to a different shift', () => {
    storage.setItem('forsage_pos_cart', JSON.stringify({ tabs: [receipt()], shiftId: 'another-shift' }))
    connect()
    expect(store.getState().items).toEqual([])
    expect(storage.getItem('forsage_pos_cart')).not.toBeNull()
  })
  it('separates cashiers and restores each own open receipt when switching back', () => {
    seed(); const leave = connect(); leave()
    const second = connect('local:cashier-two')
    expect(store.getState().items).toEqual([])
    store.getState().addItem({ ...item, productId: 'product-2' }); second()
    connect()
    expect(store.getState().items[0].productId).toBe('product-1')
  })
  it('an exit flush does not stop saving when app exit is cancelled', () => {
    const stop = connect()
    store.getState().addItem(item); stop.flush()
    store.getState().removeItem(item.productId)
    expect(saved().tabs[0].items).toEqual([])
  })
  it('does not discard other open receipts when the shift closes', () => {
    seed([receipt(), receipt('operation-0002')]); const stop = connect()
    store.getState().setCurrentShift(null); stop.flush()
    expect(saved().tabs).toHaveLength(2)
  })
  it('deduplicates only the same operation, validates malformed items and recomputes totals', () => {
    expect(parseOpenReceipts('{bad')).toBeNull()
    const tab = receipt()
    tab.items.push(null as any, { ...item, qty: -1 })
    tab.items[0].total = 1
    const result = parseOpenReceipts(JSON.stringify({ tabs: [tab, tab, receipt('operation-0002')] }))!
    expect(result.tabs).toHaveLength(2)
    expect(result.tabs[0].items).toHaveLength(1)
    expect(result.tabs[0].items[0].total).toBe(10000)
  })
  it('removes the recovery banner and manual snapshot deletion from POS source', () => {
    const source = readFileSync(new URL('./POSPage.tsx', import.meta.url), 'utf8')
    expect(source).not.toMatch(/recoverCart|handleRestoreCart|clearSavedCart|Знайдено збережений кошик|Видалити копію/)
    expect(source).toContain('connectOpenReceipts')
    // Retain financial recovery safeguards; these are not open-cart reminders.
    expect(source).toContain('setCrashSale')
  })
})
