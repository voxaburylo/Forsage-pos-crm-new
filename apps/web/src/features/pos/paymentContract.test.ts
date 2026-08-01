import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { buildRoleSafeCustomerUpdate, canManageCustomerFinancials } from '../customers/customerEditPermissions'
import { areAllDisplayedProductsSelected, toggleDisplayedProductsSelection } from '../products/productSelection'
import { canUseIntegratedTerminal, runPaymentConfirmation } from './paymentContract'
import { buildFiscalSaleItems, parseFiscalIntentUnknown } from './fiscalSale'

describe('payment confirmation contract', () => {
  it('keeps payment state intact when the sale was not completed', async () => {
    const reset = vi.fn()

    await expect(runPaymentConfirmation(async () => false, reset)).resolves.toBe(false)
    expect(reset).not.toHaveBeenCalled()
  })

  it('resets payment state only after a real sale', async () => {
    const reset = vi.fn()

    await expect(runPaymentConfirmation(async () => true, reset)).resolves.toBe(true)
    expect(reset).toHaveBeenCalledOnce()
  })
})

describe('quick customer edit permissions', () => {
  it('does not include financial settings in a cashier update', () => {
    const payload = buildRoleSafeCustomerUpdate(
      'cashier',
      { phone: '+380000000000', birth_date: '2000-01-01' },
      { bonus_balance: 5_000, discount_pct: 10, client_status: 'sto' },
    )

    expect(canManageCustomerFinancials('cashier')).toBe(false)
    expect(payload).toEqual({ phone: '+380000000000', birth_date: '2000-01-01' })
    expect(payload).not.toHaveProperty('bonus_balance')
  })

  it.each(['owner', 'admin', 'manager'])('allows %s to update financial settings', (role) => {
    expect(canManageCustomerFinancials(role)).toBe(true)
  })
})

describe('accumulated product selection', () => {
  it('selects every displayed product loaded by infinite scroll', () => {
    const displayed = Array.from({ length: 200 }, (_, index) => ({ id: `product-${index}` }))
    const firstPageSelected = new Set(displayed.slice(0, 100).map((product) => product.id))

    const selected = toggleDisplayedProductsSelection(displayed, firstPageSelected)

    expect(selected.size).toBe(200)
    expect(areAllDisplayedProductsSelected(displayed, selected)).toBe(true)
  })
})
describe('durable fiscal sale payload', () => {
  it('includes line discounts and redeemed bonuses exactly once', () => {
    const fiscalItems = buildFiscalSaleItems([
      { name: 'Товар 1', sku: 'SKU-1', qty: 1, unitPrice: 10_000, discount: 1_000 },
      { name: 'Товар 2', sku: 'SKU-2', qty: 1, unitPrice: 5_000, discount: 0 },
    ], 3_000)

    expect(fiscalItems.reduce((sum, item) => sum + item.amount, 0)).toBe(12_000)
    expect(fiscalItems.reduce((sum, item) => sum + item.discount, 0)).toBe(3_000)
  })

  it('keeps a fully bonus-paid receipt non-negative', () => {
    const fiscalItems = buildFiscalSaleItems([
      { name: 'Товар', sku: 'SKU-1', qty: 1, unitPrice: 10_000, discount: 0 },
    ], 10_000)

    expect(fiscalItems[0].amount).toBe(0)
    expect(fiscalItems[0].discount).toBe(10_000)
  })

  it('preserves a clear Ukrainian recovery message', () => {
    const parsed = parseFiscalIntentUnknown(
      new Error("Error invoking remote method: FISCAL_INTENT_UNKNOWN|sale-op-123|Результат фіскалізації потрібно перевірити у ПРРО"),
    )

    expect(parsed).toEqual({
      operationId: 'sale-op-123',
      message: 'Результат фіскалізації потрібно перевірити у ПРРО',
    })
  })
})

describe('desktop terminal safety', () => {
  it('never claims a desktop terminal is integrated without a local adapter', () => {
    expect(canUseIntegratedTerminal(true, true, 'privatbank')).toBe(false)
    expect(canUseIntegratedTerminal(false, true, 'privatbank')).toBe(true)
  })
})

describe('web sale reset generation', () => {
  it('sends the current local generation with every online sale', () => {
    const source = readFileSync(new URL('./saleApi.ts', import.meta.url), 'utf8')
    expect(source).toContain('await getLocalSyncState(scopeKey)')
    expect(source).toContain("'X-Sync-Reset-Generation': String(resetGeneration)")
    expect(source).toContain("'X-Idempotency-Key': idempotencyKey")
  })
})
