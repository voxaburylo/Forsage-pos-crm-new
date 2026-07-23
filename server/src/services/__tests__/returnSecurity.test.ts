import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/supabase.js', () => ({ db: {} }))
vi.mock('../auditService.js', () => ({ logAction: vi.fn() }))

import { resolveReturnItems } from '../returnService.js'
import { AppError } from '../../middleware/errorHandler.js'

const tenantId = '00000000-0000-0000-0000-000000000001'
const saleItem = {
  id: '10000000-0000-0000-0000-000000000001',
  product_id: '20000000-0000-0000-0000-000000000001',
  unit_price: 12_345,
  qty: 3,
  product: {
    id: '20000000-0000-0000-0000-000000000001',
    name: 'Гальмівна колодка',
    tenant_id: tenantId,
  },
}

function errorCode(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof AppError ? error.code : undefined
  }
}

describe('tenant-safe return item resolution', () => {
  it('derives the product and price from the original sale item', () => {
    const result = resolveReturnItems(
      [{
        sale_item_id: saleItem.id,
        product_id: saleItem.product_id,
        quantity: 1.25,
        condition: 'good',
      }],
      [saleItem],
      new Map(),
      'return_to_stock',
      tenantId,
    )

    expect(result).toEqual([expect.objectContaining({
      sale_item_id: saleItem.id,
      product_id: saleItem.product_id,
      unit_price: 12_345,
      quantity: 1.25,
    })])
  })

  it('rejects a client product id that does not match the receipt line', () => {
    const code = errorCode(() => resolveReturnItems(
      [{
        sale_item_id: saleItem.id,
        product_id: '20000000-0000-0000-0000-000000000099',
        quantity: 1,
        condition: 'good',
      }],
      [saleItem],
      new Map(),
      'return_to_stock',
      tenantId,
    ))
    expect(code).toBe('PRODUCT_MISMATCH')
  })

  it('rejects a product from another tenant and an excessive repeated return', () => {
    const wrongTenant = {
      ...saleItem,
      product: { ...saleItem.product, tenant_id: '30000000-0000-0000-0000-000000000001' },
    }
    const request = [{
      sale_item_id: saleItem.id,
      product_id: saleItem.product_id,
      quantity: 1,
      condition: 'good',
    }]

    expect(errorCode(() => resolveReturnItems(
      request, [wrongTenant], new Map(), 'return_to_stock', tenantId,
    ))).toBe('ITEM_NOT_FOUND')

    expect(errorCode(() => resolveReturnItems(
      request, [saleItem], new Map([[saleItem.id, 2.5]]), 'return_to_stock', tenantId,
    ))).toBe('DUPLICATE_RETURN')
  })
})
