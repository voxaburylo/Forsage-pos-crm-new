import { describe, expect, it } from 'vitest'
import type { Sale } from '@/types/sale'
import { salesInRange } from './reportApi'

function sale(id: string, status: Sale['status']): Sale {
  return {
    id,
    sale_number: id,
    customer_id: null,
    cashier_id: 'cashier',
    manager_id: null,
    shift_id: 'shift',
    status,
    subtotal: 1_000,
    discount: 0,
    total: 1_000,
    payment_method: 'cash',
    is_debt: false,
    notes: null,
    completed_at: '2026-07-22T12:00:00.000Z',
    is_fiscal: false,
    fiscal_number: null,
    bank_auth_code: null,
    cash_amount: 1_000,
    card_amount: 0,
    pickup_cell: null,
  }
}

describe('local report sales range', () => {
  it('keeps completed and returned receipts in gross sales history', () => {
    const result = salesInRange([
      sale('completed', 'completed'),
      sale('returned', 'returned'),
      sale('cancelled', 'cancelled'),
    ], '2026-07-22', '2026-07-22')

    expect(result.map((item) => item.id)).toEqual(['completed', 'returned'])
  })
})
