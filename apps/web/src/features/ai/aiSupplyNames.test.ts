import { describe, expect, it } from 'vitest'
import { flagNamesNotInSource } from './aiSupplyResponse'

describe('AI names checked against a text source', () => {
  it('flags a model number the file does not contain', () => {
    const source = '26\tVC-LX-303D2\tСабвуферний динамік Voice LX-303D2\t1\tшт.\t3,219.40'
    const [bad, good] = flagNamesNotInSource([
      { name: 'Сабвуферний динамік Voice LX-303D4', qty: 1, purchase_price_uah: 3219.4 },
      { name: 'Сабвуферний динамік Voice LX-303D2', qty: 1, purchase_price_uah: 3219.4 },
    ], source)
    expect(bad.purchase_price_note).toContain('«LX-303D4»')
    expect(good.purchase_price_note).toBeUndefined()
  })
})
