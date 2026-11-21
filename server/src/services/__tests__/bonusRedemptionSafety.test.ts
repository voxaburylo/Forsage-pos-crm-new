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
// Рішення власника 20.11.2026 — ті самі правила, що й на касі: бонуси не згорають, ними можна
// оплатити весь товар (без межі у відсотках і без вимикача програми), відсоток — особистий клієнта,
// нараховується в бонуси (не на рахунок клієнта) і не на частину, оплачену бонусами.
describe('server bonus spending follows the owner rule', () => {
  it('spends saved bonuses even when the group program switch is off', async () => {
    fixture.settings.is_enabled = false
    await expect(checkout(100)).rejects.toThrow('TERMINAL_REACHED')
  })
  it.each([[3001, 3001], [10000, 10000], [2701, 3701]])('allows %i of bonuses up to all goods', async (bonus, discount) => {
    fixture.settings.max_redeem_pct = 0
    await expect(checkout(bonus, discount)).rejects.toThrow('TERMINAL_REACHED')
    expect(fixture.terminal).toHaveBeenCalledTimes(1)
  })
  it('does not spend without a customer', async () => {
    await expect(checkout(100, 100, '')).rejects.toMatchObject({ code: 'CUSTOMER_REQUIRED' })
    expect(fixture.terminal).not.toHaveBeenCalled()
  })
  it('does not debit bonuses without a corresponding receipt discount', async () => {
    await expect(checkout(100, 0)).rejects.toMatchObject({ code: 'INVALID_BONUS_DISCOUNT' })
    expect(fixture.terminal).not.toHaveBeenCalled()
  })
  it('does not disguise settings read failure as disabled loyalty', async () => {
    fixture.settingsError = { message: 'synthetic settings unavailable' }
    await expect(getSettings('tenant')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('server accrual follows the owner rule (synthetic transaction boundary)', () => {
  function transactionProbe(stop: 'sale' | 'earn', tier: number | null = null) {
    const captured: { sale?: unknown[]; earn?: unknown[]; deposit?: unknown[]; expiryRead?: boolean } = {}
    fixture.transaction.mockImplementation(async run => run({ query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('FROM products')) return { rowCount: 1, rows: [{ qty_on_hand: 10, is_service: true, cost_price: 0, requires_core_return: true, core_deposit_amount: fixture.coreDeposit }] }
      if (sql.includes('FROM customers')) return { rowCount: 1, rows: [{ id: 'customer', bonus_balance: 100000, deposit_balance: 0, loyalty_mode: 'cashback', discount_pct: 5, price_tier_id: tier === null ? null : 'tier' }] }
      if (sql.includes('FROM price_tiers')) return { rowCount: 1, rows: [{ discount_pct: tier }] }
      if (sql.includes('FROM bonus_transactions')) captured.expiryRead = true
      if (sql.includes('INSERT INTO sales')) {
        captured.sale = values
        if (stop === 'sale') throw Error('SALE_PROBED')
        return { rowCount: 1, rows: [{ id: 'sale', sale_number: '000001' }] }
      }
      if (sql.includes('INSERT INTO customer_deposit_transactions')) captured.deposit = values
      if (sql.includes('INSERT INTO bonus_transactions') && sql.includes("'earn'")) {
        captured.earn = values
        throw Error('EARN_PROBED')
      }
      return { rowCount: 1, rows: [{}] }
    } }))
    return captured
  }
  function cashCheckout(discount = 0, method: 'cash' | 'debt' = 'cash', price = 10000, bonuses = 0) {
    return createSale('cashier', 'tenant', { shift_id: 'shift', customer_id: 'customer', payment_method: method, bonuses_spent: bonuses, discount, cash_amount: 0, card_amount: 0, is_fiscal: false,
      items: [{ product_id: 'product', unit_price: price, qty: 1, discount: 0 }] } as any)
  }
  it('has no group accrual and never reads bonus expiry', async () => {
    fixture.settings.accrual_pct = 50; fixture.settings.expiry_days = 30 as any
    const captured = transactionProbe('sale')
    await expect(cashCheckout()).rejects.toThrow('SALE_PROBED')
    expect(captured.sale?.[15]).toBe(0)
    expect(captured.expiryRead).toBeUndefined()
  })
  it.each([[null, 450], [10, 450]])('credits the personal 5%% to bonuses, ignoring tier %s', async (tier, expected) => {
    fixture.coreDeposit = 20000
    const captured = transactionProbe('earn', tier)
    await expect(cashCheckout(1000)).rejects.toThrow('EARN_PROBED')
    expect(captured.earn?.[2]).toBe(expected)
    expect(captured.deposit).toBeUndefined()
  })
  it('does not accrue on the part paid with bonuses', async () => {
    const captured = transactionProbe('earn')
    await expect(cashCheckout(4000, 'cash', 10000, 4000)).rejects.toThrow('EARN_PROBED')
    expect(captured.earn?.[2]).toBe(300)
  })
})
