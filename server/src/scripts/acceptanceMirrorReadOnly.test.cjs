const test = require('node:test')
const assert = require('node:assert/strict')
const { canonical, normalizedRow, remoteTables, remoteColumns } = require('./acceptanceMirrorReadOnly.cjs')
test('calendar days do not turn into the previous UTC day', () => {
  assert.equal(canonical('2026-06-11', 'date', 'work_date'), '2026-06-11')
  assert.throws(() => canonical(new Date('2026-06-10T21:00:00Z'), 'date', 'work_date'))
})
test('timestamps, booleans and money normalize without calendar conversion', () => {
  assert.equal(canonical('2026-06-11T00:00:00+03:00', 'timestamp with time zone', 'created_at'), '2026-06-10T21:00:00.000Z')
  assert.equal(canonical(1, 'boolean', 'is_debt'), true)
  assert.equal(canonical('12345', 'integer', 'amount'), 12345)
})
test('legacy debt null is derived only according to the sale mirror contract', () => {
  const base = { total: 1000, cash_amount: 300, card_amount: 200, transfer_amount: 100, debt_amount: null }
  assert.equal(normalizedRow('sales', base).debt_amount, 0)
  assert.equal(normalizedRow('sales', { ...base, is_debt: true }).debt_amount, 400)
  assert.equal(normalizedRow('sales', { ...base, payment_method: 'debt' }).debt_amount, 400)
  assert.equal(normalizedRow('sales', { ...base, debt_amount: 99 }).debt_amount, 99)
  assert.equal(base.debt_amount, null)
})
test('return and purchase-cost mappings match explicit mirror destinations', () => {
  assert.equal(remoteTables.customer_returns, 'returns')
  assert.equal(remoteTables.customer_return_items, 'return_items')
  assert.equal(remoteColumns.sale_items.purchase_price, 'cost_price')
})
