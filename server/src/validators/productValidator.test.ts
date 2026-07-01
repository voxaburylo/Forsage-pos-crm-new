import { describe, expect, it } from 'vitest'
import { createProductSchema, updateProductSchema } from './productValidator.js'

const baseProduct = {
  sku: 'POS-TEST',
  name: 'POS TEST',
  purchase_price: 0,
  retail_price: 500,
}

describe('product service flag', () => {
  it('preserves is_service when a service product is created', () => {
    expect(createProductSchema.parse({ ...baseProduct, is_service: true }).is_service).toBe(true)
  })

  it('defaults regular products to inventory tracking', () => {
    expect(createProductSchema.parse(baseProduct).is_service).toBe(false)
  })

  it('allows changing is_service during editing', () => {
    expect(updateProductSchema.parse({ is_service: true })).toEqual({ is_service: true })
  })
})
