import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalOrderRepository } from '../src/repositories/orderRepository'

const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w=='
const PNG = 'data:image/png;base64,iVBORw0KGgo='

// 24.11.2026 (план C2): мініатюри позицій замовлення живуть на головному ПК, без зміни схеми бази.
describe('order item thumbnails', () => {
  let root: string, db: LocalDatabase, orders: LocalOrderRepository
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'forsage-item-photo-')); db = new LocalDatabase(root); orders = new LocalOrderRepository(db) })
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  let serial = 0
  const order = (items: Array<Record<string, unknown>>, id?: string, version?: string) => orders.saveOrder({
    comment: 'тест ' + ++serial, ...(version ? { expected_updated_at: version } : {}),
    items: items.map(item => ({ qty: 1, sell_price: 10000, source_type: 'supplier', ...item })),
  }, id)

  it('keeps a thumbnail per item, ignores anything that is not a small picture, and never touches the sync payload', () => {
    const saved = order([
      { name: 'Колодки', sku: 'GDB-1550', photo_data_url: JPEG },
      { name: 'Фільтр', sku: 'W712', photo_data_url: 'javascript:alert(1)' },
      { name: 'Свічка', sku: 'BKR6E', photo_data_url: 'data:image/jpeg;base64,' + 'A'.repeat(90_000) },
    ])
    const [pads, filter, plug] = saved.items
    expect(orders.listItemPhotos(saved.id)).toEqual({ [pads.id]: JPEG })
    expect(filter.id && plug.id).toBeTruthy()
    const outbox = db.prepare("SELECT payload_json FROM sync_outbox WHERE aggregate_id = ?").all(saved.id) as Array<{ payload_json: string }>
    expect(outbox.some(row => row.payload_json.includes('data:image'))).toBe(false)
  })

  it('the parts reference offers the last thumbnail of the same article, by exact article only', () => {
    order([{ name: 'Колодки', sku: 'GDB-1550', photo_data_url: JPEG }])
    order([{ name: 'Колодки нові', sku: 'gdb 1550', photo_data_url: PNG }])
    expect(orders.partPhoto('GDB1550')).toBe(PNG)
    expect(orders.partPhoto('GDB155')).toBeNull()
    expect(orders.partPhoto('ab')).toBeNull()
    const suggestion = orders.suggestOrderParts('GDB1550')
    expect(suggestion[0]).toMatchObject({ sku: expect.stringMatching(/gdb ?-?1550/i), photo: PNG })
  })

  it('removing the thumbnail in the form deletes it; resaving without the field keeps it', () => {
    const saved = order([{ name: 'Колодки', sku: 'GDB-1550', photo_data_url: JPEG }])
    const item = saved.items[0]
    const again = order([{ id: item.id, name: 'Колодки', sku: 'GDB-1550' }], saved.id, saved.updated_at)
    expect(orders.listItemPhotos(saved.id)).toEqual({ [item.id]: JPEG })
    order([{ id: item.id, name: 'Колодки', sku: 'GDB-1550', photo_data_url: null }], saved.id, again.updated_at)
    expect(orders.listItemPhotos(saved.id)).toEqual({})
    expect(() => orders.listItemPhotos("x' OR 1")).toThrow('Некоректне замовлення')
  })
})
