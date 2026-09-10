import { describe, expect, it } from 'vitest'
import { createLatestRequest } from './useLatestRequest'

describe('latest request gate', () => {
  it('ignores an older response finishing after a new search', async () => {
    const gate = createLatestRequest()
    const first = gate.begin()
    const second = gate.begin()
    await Promise.resolve()
    expect(second()).toBe(true)
    expect(first()).toBe(false)
  })
  it('invalidates work when filters change or the page unmounts', () => {
    const gate = createLatestRequest()
    const old = gate.begin()
    gate.invalidate()
    expect(old()).toBe(false)
    expect(gate.begin()()).toBe(true)
  })
  it('keeps independent panels independent', () => {
    const list = createLatestRequest()
    const detail = createLatestRequest()
    const active = detail.begin()
    list.begin()
    list.invalidate()
    expect(active()).toBe(true)
  })
})
