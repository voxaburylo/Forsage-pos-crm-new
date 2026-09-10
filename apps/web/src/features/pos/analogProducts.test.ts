import { describe, it, expect } from 'vitest'
import type { Product } from '@/types/product'
import { normalizeAnalogs, queueAnalogLookup } from './analogLookup'
describe('inline POS analogs', () => {
  it('counts unique alternatives, excludes source, shows available first', () => {
    const rows = [{id:'source',name:'Source',qty_on_hand:2},{id:'empty',name:'A',qty_on_hand:0},{id:'yes',name:'Z',qty_on_hand:2}]
    const found = normalizeAnalogs('source', [...rows, rows[2]] as Product[])
    expect(found.map(p=>p.id)).toEqual(['yes','empty'])
  })
  it('uses available stock after reservations', () => {
    expect(normalizeAnalogs('source', [
      {id:'reserved',name:'A',qty_on_hand:5,qty_available:0},
      {id:'free',name:'Z',qty_on_hand:1,qty_available:1},
    ] as Product[]).map(p=>p.id)).toEqual(['free','reserved'])
  })
  it('skips cancelled work and continues after errors', async () => {
    let calls=0
    await queueAnalogLookup(()=>false,async()=>{calls++; return []})
    expect(calls).toBe(0)
    await expect(queueAnalogLookup(()=>true,async()=>{throw Error('offline')})).rejects.toThrow()
    expect(await queueAnalogLookup(()=>true,async()=>42)).toBe(42)
  })
})
