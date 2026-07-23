import { beforeEach, describe, expect, it } from 'vitest'
import { useAuthStore } from './authStore'
import { usePOSStore } from './posStore'

const ITEM = {
  productId: 'product-1',
  sku: 'SKU-1',
  name: 'Тестовий товар',
  unit: 'шт',
  qty: 1,
  unitPrice: 10_000,
  discount: 1_000,
  discountPct: 10,
  qtyOnHand: 10,
}

describe('posStore discounts', () => {
  beforeEach(() => {
    usePOSStore.getState().clearReceipt()
    useAuthStore.setState({
      session: { user: { app_metadata: { role: 'owner' } } } as any,
    })
  })

  it('scales an automatic discount when quantity changes', () => {
    const store = usePOSStore.getState()
    store.addItem(ITEM)
    store.addItem(ITEM)

    expect(usePOSStore.getState().items[0]).toMatchObject({
      qty: 2,
      discount: 2_000,
      total: 18_000,
    })

    usePOSStore.getState().updateQty('product-1', 3)
    expect(usePOSStore.getState().items[0]).toMatchObject({
      qty: 3,
      discount: 3_000,
      total: 27_000,
    })
  })

  it('never lets a manual discount make a line total negative', () => {
    usePOSStore.getState().addItem({ ...ITEM, discount: 0, discountPct: undefined })
    usePOSStore.getState().setDiscount('product-1', 99_999)

    expect(usePOSStore.getState().items[0]).toMatchObject({
      discount: 10_000,
      total: 0,
    })
    expect(usePOSStore.getState().total).toBe(0)
  })

  it('does not overwrite a manager-entered discount with an automatic tier discount', () => {
    usePOSStore.getState().addItem({ ...ITEM, discount: 0, discountPct: undefined })
    usePOSStore.getState().setDiscount('product-1', 1_500)
    usePOSStore.getState().setAutomaticDiscountPct(20)

    expect(usePOSStore.getState().items[0]).toMatchObject({
      discount: 1_500,
      total: 8_500,
    })
  })
})
