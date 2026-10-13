import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  settings: { is_enabled: true, max_redeem_pct: 30, accrual_pct: 2, min_purchase_kopecks: 10000, expiry_days: null },
  settingsError: null as null | { message: string },
  coreDeposit: 0,
  terminal: vi.fn(), transaction: vi.fn(),
}))
vi.mock('../../db/supabase.js', () => ({ db: { from: (table: string) => {
  const result = () => table === 'loyalty_settings' ? { data: fixture.settingsError ? null : fixture.settings, error: fixture.settingsError } : { data: table === 'products' ? [{ id: 'product', requires_core_return: true, core_deposit_amount: fixture.coreDeposit }] : [], error: null }
  const query: any = { select: () => query, eq: () => query, in: () => query, maybeSingle: async () => result(), then: (resolve: any) => Promise.resolve(result()).then(resolve) }
  return query
} } }))
vi.mock('../../db/pg.js', () => ({ runTransaction: fixture.transaction }))
vi.mock('../syncGeneration.js', () => ({ assertTenantSyncGenerationInTransaction: vi.fn() }))
vi.mock('../shiftService.js', () => ({ getCurrentShift: async () => ({ id: 'shift' }) }))
vi.mock('../auditService.js', () => ({ logAction: vi.fn() }))
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../adminService.js', () => ({ getSettings: async () => ({ bank_terminal_enabled: true, terminal_provider: 'fixture' }) }))
vi.mock('../integrations/adapterFactory.js', () => ({ getTerminalAdapter: () => ({ processPayment: fixture.terminal }), getFiscalAdapter: vi.fn() }))
import { createSale } from '../saleService.js'
import { getSettings } from '../loyaltyService.js'

beforeEach(() => {
  vi.clearAllMocks()
  fixture.settings = { is_enabled: true, max_redeem_pct: 30, accrual_pct: 2, min_purchase_kopecks: 10000, expiry_days: null }
  fixture.settingsError = null
  fixture.coreDeposit = 0
  fixture.terminal.mockRejectedValue(new Error('TERMINAL_REACHED'))
  fixture.transaction.mockRejectedValue(new Error('TRANSACTION_REACHED'))
})
function checkout(bonus: number, discount = bonus, customer_id: string | undefined = 'customer') {
  return createSale('cashier', 'tenant', { shift_id: 'shift', customer_id, payment_method: 'card', bonuses_spent: bonus, discount, cash_amount: 0, card_amount: 0, is_fiscal: false,
    items: [{ product_id: 'product', unit_price: 10000, qty: 1, discount: 0 }] } as any)
}
describe('server checks its configured bonus policy before payment', () => {
  it('rejects a disabled program before terminal or transaction', async () => {
    fixture.settings.is_enabled = false
    await expect(checkout(100)).rejects.toMatchObject({ code: 'LOYALTY_DISABLED' })
    expect(fixture.terminal).not.toHaveBeenCalled(); expect(fixture.transaction).not.toHaveBeenCalled()
  })
  it.each([[30, 3001, 3001], [10, 1001, 1001], [30, 2701, 3701], [0, 1, 1]])('rejects above %i%% cap before charging', async (percentage, bonus, discount) => {
    fixture.settings.max_redeem_pct = percentage
    await expect(checkout(bonus, discount)).rejects.toMatchObject({ code: 'BONUS_LIMIT_EXCEEDED' })
    expect(fixture.terminal).not.toHaveBeenCalled(); expect(fixture.transaction).not.toHaveBeenCalled()
  })
  it('does not spend without a customer', async () => {
    await expect(checkout(100, 100, '')).rejects.toMatchObject({ code: 'CUSTOMER_REQUIRED' })
    expect(fixture.terminal).not.toHaveBeenCalled()
  })
  it('does not debit bonuses without a corresponding receipt discount', async () => {
    await expect(checkout(100, 0)).rejects.toMatchObject({ code: 'INVALID_BONUS_DISCOUNT' })
    expect(fixture.terminal).not.toHaveBeenCalled()
  })
  it.each([[30, 3000, 3000], [10, 1000, 1000], [30, 2700, 3700], [100, 10000, 10000]])('preserves configured %i%% boundary', async (percentage, bonus, discount) => {
    fixture.settings.max_redeem_pct = percentage
    await expect(checkout(bonus, discount)).rejects.toThrow('TERMINAL_REACHED')
    expect(fixture.terminal).toHaveBeenCalledTimes(1)
  })
  it('does not disguise settings read failure as disabled loyalty', async () => {
    fixture.settingsError = { message: 'synthetic settings unavailable' }
    await expect(getSettings('tenant')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
  it('does not charge when redemption settings cannot be read', async () => {
    fixture.settingsError = { message: 'synthetic settings unavailable' }
    await expect(checkout(100)).rejects.toMatchObject({ code: 'DB_ERROR' })
    expect(fixture.terminal).not.toHaveBeenCalled()
  })
  it('does not count refundable core deposits toward the redemption cap', async () => {
    fixture.coreDeposit = 20000
    await expect(checkout(3001)).rejects.toMatchObject({ code: 'BONUS_LIMIT_EXCEEDED' })
    expect(fixture.terminal).not.toHaveBeenCalled()
  })
})

// Characterization, not a new business rule: expose existing server behavior
// for comparison with the local repository. No real PostgreSQL/service calls.
describe('existing server accrual policy (synthetic transaction boundary)', () => {
  function transactionProbe(stop: 'sale' | 'cashback', tier: number | null = null) {
    const captured: { sale?: unknown[]; cashback?: unknown[] } = {}
    fixture.transaction.mockImplementation(async run => run({ query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('FROM products')) return { rowCount: 1, rows: [{ qty_on_hand: 10, is_service: true, cost_price: 0, requires_core_return: true, core_deposit_amount: fixture.coreDeposit }] }
      if (sql.includes('FROM customers')) return { rowCount: 1, rows: [{ id: 'customer', bonus_balance: 100000, deposit_balance: 0, loyalty_mode: 'cashback', discount_pct: 5, price_tier_id: tier === null ? null : 'tier' }] }
      if (sql.includes('FROM price_tiers')) return { rowCount: 1, rows: [{ discount_pct: tier }] }
      if (sql.includes('INSERT INTO sales')) {
        captured.sale = values
        if (stop === 'sale') throw Error('SALE_PROBED')
        return { rowCount: 1, rows: [{ id: 'sale', sale_number: '000001' }] }
      }
      if (sql.includes('INSERT INTO customer_deposit_transactions')) {
        captured.cashback = values
        throw Error('CASHBACK_PROBED')
      }
      return { rowCount: 1, rows: [{}] }
    } }))
    return captured
  }
  function cashCheckout(discount = 0, method: 'cash' | 'debt' = 'cash', price = 10000) {
    return createSale('cashier', 'tenant', { shift_id: 'shift', customer_id: 'customer', payment_method: method, bonuses_spent: 0, discount, cash_amount: 0, card_amount: 0, is_fiscal: false,
      items: [{ product_id: 'product', unit_price: price, qty: 1, discount: 0 }] } as any)
  }
  it.each([
    { enabled: true, minimum: 0, discount: 1000, price: 10000, method: 'cash' as const, expected: 180 },
    { enabled: true, minimum: 10000, discount: 1000, price: 10000, method: 'cash' as const, expected: 0 },
    { enabled: false, minimum: 0, discount: 0, price: 10000, method: 'cash' as const, expected: 0 },
    { enabled: true, minimum: 0, discount: 0, price: 10000, method: 'debt' as const, expected: 0 },
    { enabled: true, minimum: 0, discount: 0, price: 103, method: 'cash' as const, expected: 2 },
  ])('keeps accrual $expected excluding core: enabled=$enabled method=$method', async ({ enabled, minimum, discount, price, method, expected }) => {
    fixture.settings.is_enabled = enabled; fixture.settings.min_purchase_kopecks = minimum; fixture.coreDeposit = 20000
    const captured = transactionProbe('sale')
    await expect(cashCheckout(discount, method, price)).rejects.toThrow('SALE_PROBED')
    expect(captured.sale?.[15]).toBe(expected)
    expect(fixture.terminal).not.toHaveBeenCalled()
  })
  it.each([[null, 450], [10, 900]])('characterizes personal 5%% vs configured tier %s%% cashback', async (tier, expected) => {
    fixture.coreDeposit = 20000
    const captured = transactionProbe('cashback', tier)
    await expect(cashCheckout(1000)).rejects.toThrow('CASHBACK_PROBED')
    expect(captured.cashback?.[2]).toBe(expected)
  })
})
