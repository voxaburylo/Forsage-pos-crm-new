import { describe, expect, it } from 'vitest'
import { splitReservedOrder } from './reservedOrderToast'

// 27.11.2026: каса пише в помилку мітку замовлення — касир бачить чистий текст і кнопку «Відкрити замовлення».
describe('sale error about stock reserved for an order', () => {
  it('takes the order id out of the text', () => {
    const id = '3f2a8c1e-1111-4a2b-9c3d-0123456789ab'
    expect(splitReservedOrder(`Недостатньо товару «Фільтр s»: товар у замовленні №S-17 (сайт, оплачено). Доступно: 0, потрібно: 1. Продати заброньоване не можна. [order:${id}]`))
      .toEqual({ text: 'Недостатньо товару «Фільтр s»: товар у замовленні №S-17 (сайт, оплачено). Доступно: 0, потрібно: 1. Продати заброньоване не можна.', orderId: id })
  })
  it('leaves other errors as they are', () => {
    expect(splitReservedOrder('Спочатку відкрийте касову зміну s')).toEqual({ text: 'Спочатку відкрийте касову зміну s', orderId: null })
  })
})
