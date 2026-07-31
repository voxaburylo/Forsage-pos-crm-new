import { describe, expect, it } from 'vitest'
import { buildProductSyncQueryValues } from '../syncProductValues.js'

describe('product sync SQL parameters', () => {
  it('passes 23 values to INSERT and adds the 24th flag only to UPDATE', () => {
    const base = Array.from({ length: 23 }, (_, index) => `value-${index + 1}`)
    const values = buildProductSyncQueryValues(base, true)

    expect(values.insertValues).toHaveLength(23)
    expect(values.updateValues).toHaveLength(24)
    expect(values.updateValues.at(-1)).toBe(true)
    expect(values.insertValues).not.toBe(values.updateValues)
  })

  it('fails before querying PostgreSQL if the shared list changes accidentally', () => {
    expect(() => buildProductSyncQueryValues(Array(24).fill(null), false))
      .toThrow(/expected 23, got 24/)
  })
})
