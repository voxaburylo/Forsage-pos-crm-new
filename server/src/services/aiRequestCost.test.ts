import { describe, expect, it, vi } from 'vitest'
vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }))
vi.mock('../db/supabase.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../lib/crypto.js', () => ({ encryptSecret: (s: string) => s, decryptSecret: (s: string) => s }))
vi.mock('./searchService.js', () => ({ searchProductsForPOS: vi.fn() }))
vi.mock('./productService.js', () => ({ getProduct: vi.fn(), createProduct: vi.fn(), updateProduct: vi.fn() }))
vi.mock('./adminService.js', () => ({ listCategories: vi.fn(), createCategory: vi.fn() }))
vi.mock('./customerService.js', () => ({ listCustomers: vi.fn(), updateCustomer: vi.fn() }))
import { requestCostQuantiles } from './aiService.js'

// 24.11.2026 (план C2): звичайна й «дорога» ціна запиту в цьому магазині.
describe('typical AI request cost', () => {
  it('takes the median and the 90% cost, ignoring empty and broken values', () => {
    expect(requestCostQuantiles([0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 1, 0, -1, Number.NaN]))
      .toEqual({ typical_usd: 0.05, heavy_usd: 0.09, sample: 10 })
  })
  it('too little data gives nothing', () => {
    expect(requestCostQuantiles([0.1, 0.2])).toEqual({})
  })
})
