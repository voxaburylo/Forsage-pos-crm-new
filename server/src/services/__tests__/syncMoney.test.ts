import { describe, expect, it } from 'vitest'
import { checkedSyncMoney, MAX_SYNC_MONEY } from '../syncMoney.js'

describe('sync money validation', () => {
  it('accepts PostgreSQL integer money values', () => {
    expect(checkedSyncMoney(MAX_SYNC_MONEY, 'Сума')).toBe(MAX_SYNC_MONEY)
  })

  it('rejects a barcode-sized value with a useful message', () => {
    expect(() => checkedSyncMoney(200_099_884_047_100, 'Ціна закупівлі'))
      .toThrow(/штрихкод випадково не потрапив у поле ціни/)
  })
})
