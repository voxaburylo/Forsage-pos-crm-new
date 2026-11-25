import { describe, expect, it } from 'vitest'
import { applicabilityLines } from './SupplierProductDetails'

describe('Omega description in the product card', () => {
  it('shows applicability briefly: make with up to 8 models', () => {
    const models = Array.from({ length: 10 }, (_, i) => ({ name: 'M' + i, children: [] }))
    expect(applicabilityLines([{ name: 'BMW', children: models }, { name: 'Audi', children: [] }]))
      .toEqual(['BMW: M0, M1, M2, M3, M4, M5, M6, M7 і ще 2', 'Audi'])
  })
})
