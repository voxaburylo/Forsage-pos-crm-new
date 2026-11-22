import { beforeEach, describe, expect, it } from 'vitest'
import { usePOSStore } from '@/stores/posStore'
import { useAuthStore } from '@/stores/authStore'
import { parseOpenReceipts } from './cartRecovery'
import { posLineAmounts, posLineCost, posSaleBlockReason } from './posMoney'

const store = usePOSStore
// Закупка 5000 грн, націнка 30% → продаж 6500 грн.
const part = { productId: 'part', sku: 'P-1', name: 'Амортизатор', unit: 'шт', qty: 1,
  unitPrice: 650_000, purchasePrice: 500_000, discount: 0, qtyOnHand: 5 }
const customer = { id: 'c-1', name: 'Менеджер', phone: '+38 (067) 111-22-33', debtBalance: 0,
  tierDiscountPct: 0, tierName: null, vipLevel: 'standard' as const, riskProfile: 'low' as const }

beforeEach(() => {
  store.getState().replaceOpenReceipts([])
  store.getState().setPriceRounding({ enabled: false })
  store.getState().setEmployeeDiscount(0, [])
  useAuthStore.setState({ session: { user: { app_metadata: { role: 'owner' } } } as any })
})

describe('shop rule: nothing is sold below the purchase price', () => {
  it('stops a 30% discount at cost instead of 4550', () => {
    expect(posLineAmounts({ ...part, discountPct: 30 })).toEqual({ discount: 150_000, total: 500_000 })
  })
  it('keeps a discount that still leaves the price above cost', () => {
    expect(posLineAmounts({ ...part, discountPct: 10 })).toEqual({ discount: 65_000, total: 585_000 })
  })
  it('scales the floor with quantity and ignores an unknown purchase price', () => {
    expect(posLineAmounts({ ...part, qty: 3, discountPct: 50 })).toEqual({ discount: 450_000, total: 1_500_000 })
    expect(posLineCost({ qty: 2 })).toBe(0)
    expect(posLineAmounts({ unitPrice: 10_000, qty: 1, discount: 0, discountPct: 90 })).toEqual({ discount: 9_000, total: 1_000 })
    // 22.11.2026: 100 % = «працівнику за закупкою». Без відомої закупки рядок не стає безкоштовним — знижка на нього не діє.
    expect(posLineAmounts({ unitPrice: 10_000, qty: 1, discount: 0, discountPct: 100 })).toEqual({ discount: 0, total: 10_000 })
    // Ручна знижка сумою лишається можливою.
    expect(posLineAmounts({ unitPrice: 10_000, qty: 1, discount: 10_000 })).toEqual({ discount: 10_000, total: 0 })
  })
  it('gives an employee the personal price from the staff card: own percent or the purchase price (owner decision 22.11.2026)', () => {
    const service = { productId: 'svc', sku: 'S-1', name: 'Шиномонтаж', unit: 'посл', qty: 1, unitPrice: 40_000, discount: 0, qtyOnHand: 0 }
    // Загальна знижка 10 %; у Олени своя 20 %, Петро купує за закупкою, у Івана особистої немає.
    store.getState().setEmployeeDiscount(10, ['0671112233', '0672223344', '0673334455'], [{ phone: '0671112233', pct: 20 }, { phone: '+380672223344', pct: 100 }])
    const buy = (phone: string) => {
      store.getState().replaceOpenReceipts([])
      store.getState().setCustomer({ ...customer, phone })
      store.getState().setAutomaticDiscountPct(0)
      store.getState().addItem(part)
      store.getState().addItem(service)
      return store.getState().items.map(item => item.total)
    }
    expect(buy('067 111 22 33')).toEqual([520_000, 32_000])
    // За закупкою: товар — рівно закупівельна ціна, послуга без закупки — повна ціна, а не безкоштовно.
    expect(buy('067 222 33 44')).toEqual([500_000, 40_000])
    expect(store.getState().customer?.tierName).toBe('Працівник: за закупкою')
    expect(buy('067 333 44 55')).toEqual([585_000, 36_000])
    // Сторонній клієнт нічого не отримує.
    expect(buy('050 000 00 00')).toEqual([650_000, 40_000])
  })
  it('applies the floor to the customer discount and to a manual discount in the basket', () => {
    store.getState().setCustomer({ ...customer, tierDiscountPct: 30 })
    store.getState().setAutomaticDiscountPct(30)
    store.getState().addItem(part)
    expect(store.getState().items[0]).toMatchObject({ discount: 150_000, total: 500_000 })
    store.getState().setDiscount('part', 400_000)
    expect(store.getState().items[0]).toMatchObject({ discount: 150_000, total: 500_000 })
    // Ручна знижка — це сума на рядок: при зміні кількості межа перераховується.
    store.getState().updateQty('part', 2)
    store.getState().setDiscount('part', 400_000)
    expect(store.getState().total).toBe(1_000_000)
    store.getState().updateQty('part', 1)
    expect(store.getState().total).toBe(500_000)
  })
  it('keeps the floor after a saved basket is reopened', () => {
    store.getState().addItem({ ...part, discountPct: 30 })
    const saved = parseOpenReceipts(JSON.stringify({ tabs: store.getState().tabs }))
    store.getState().replaceOpenReceipts(saved!.tabs)
    expect(store.getState().items[0]).toMatchObject({ purchasePrice: 500_000, total: 500_000 })
  })
  it('refuses a product without a price or priced below cost, and names it', () => {
    expect(posSaleBlockReason({ name: 'Фільтр', unitPrice: 0 })).toContain('Фільтр')
    expect(posSaleBlockReason({ name: 'Фільтр', unitPrice: 400_000, purchasePrice: 500_000 })).toContain('нижча за закупівельну')
    expect(posSaleBlockReason({ name: 'Фільтр', unitPrice: 500_000, purchasePrice: 500_000 })).toBeNull()
    expect(posSaleBlockReason({ name: 'Послуга', unitPrice: 10_000 })).toBeNull()
  })
})

describe('employee discount setting', () => {
  it('applies by itself when the chosen customer has a staff phone, and never below cost', () => {
    store.getState().setEmployeeDiscount(50, ['0671112233'])
    store.getState().setCustomer(customer)
    store.getState().setAutomaticDiscountPct(0)
    expect(store.getState().customer).toMatchObject({ tierDiscountPct: 50, tierName: 'Працівник' })
    store.getState().addItem(part)
    expect(store.getState().items[0]).toMatchObject({ discountPct: 50, total: 500_000 })
  })
  it('does nothing for other customers or when the setting is zero', () => {
    store.getState().setEmployeeDiscount(50, ['0509998877'])
    store.getState().setCustomer({ ...customer, tierDiscountPct: 5 })
    store.getState().setAutomaticDiscountPct(5)
    expect(store.getState().automaticDiscountPct).toBe(5)
    store.getState().setEmployeeDiscount(0, ['0671112233'])
    store.getState().setCustomer(customer)
    store.getState().setAutomaticDiscountPct(0)
    expect(store.getState().automaticDiscountPct).toBe(0)
  })
  it('keeps a larger personal discount from the customer card', () => {
    store.getState().setEmployeeDiscount(10, ['0671112233'])
    store.getState().setCustomer({ ...customer, tierDiscountPct: 15, tierName: 'Опт' })
    store.getState().setAutomaticDiscountPct(15)
    expect(store.getState().customer).toMatchObject({ tierDiscountPct: 15, tierName: 'Опт' })
    expect(store.getState().automaticDiscountPct).toBe(15)
  })
})
