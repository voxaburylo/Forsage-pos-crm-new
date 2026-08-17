import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createProductSchema } from '../../validators/productValidator.js'

const migration = readFileSync(
  new URL('../../../../supabase/migrations/20260816221500_expand_product_sku.sql', import.meta.url),
  'utf8',
)

const validProduct = {
  sku: 'A'.repeat(100),
  name: 'Тестовий товар',
  purchase_price: 100,
  retail_price: 150,
}

describe('product SKU capacity', () => {
  it('accepts an imported article longer than the legacy 50-character limit', () => {
    expect(createProductSchema.safeParse(validProduct).success).toBe(true)
    expect(createProductSchema.safeParse({ ...validProduct, sku: 'A'.repeat(201) }).success).toBe(false)
  })

  it('keeps catalog and dependent document columns at the same capacity', () => {
    expect(migration).toContain('ALTER COLUMN sku TYPE VARCHAR(200)')
    expect(migration).toContain('ALTER TABLE public.customer_order_items')
    expect(migration).toContain('ALTER TABLE public.supplier_price_items')
    expect(migration).toContain('security_invoker = true')
    expect(migration).toContain('REVOKE ALL ON public.products_low_stock FROM PUBLIC, anon, authenticated')
  })
})
