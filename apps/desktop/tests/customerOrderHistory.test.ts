import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalOrderRepository } from '../src/repositories/orderRepository'
import { LocalPosRepository } from '../src/repositories/posRepository'

describe('customer/chat history beyond the global first 200 orders', () => {
  let root: string, db: LocalDatabase, orders: LocalOrderRepository, customer: string
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-order-history-'))
    db = new LocalDatabase(root); orders = new LocalOrderRepository(db)
    customer = new LocalPosRepository(db).saveCustomer({ phone: '0671234567' }).data.id
    const insert = db.prepare('INSERT INTO customer_orders(id,tenant_id,customer_id,chat_id,status,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?)')
    db.transaction(() => {
      for (let i = 0; i < 600; i++) insert.run('new-' + i, DEFAULT_TENANT_ID, null, 'other', 'new', '2026-10-13', '2026-10-13', null)
      for (let i = 0; i < 61; i++) insert.run('old-' + String(i).padStart(3, '0'), DEFAULT_TENANT_ID, customer, i < 30 ? 'chat-A' : 'chat-B', 'completed', '2026-07-01', '2026-07-01', null)
      insert.run(randomUUID(), DEFAULT_TENANT_ID, customer, 'chat-A', 'completed', '2026-07-01', '2026-07-01', '2026-07-02')
      insert.run(randomUUID(), 'another-tenant', customer, 'chat-A', 'completed', '2026-07-01', '2026-07-01', null)
    })
  })
  afterEach(() => { db.close(); if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-order-history-')) rmSync(root, { recursive: true, force: true }) })
  it('finds every old customer order in stable pages, without unrelated/deleted/cross-tenant rows', () => {
    expect(orders.listOrders().every(order => order.customer_id === null)).toBe(true)
    const pages = [0, 25, 50].flatMap(offset => orders.listOrders({ customer_id: customer, offset, limit: 25 }))
    expect(pages).toHaveLength(61); expect(new Set(pages.map(order => order.id)).size).toBe(61)
    expect(pages.every(order => order.customer_id === customer && order.id.startsWith('old-'))).toBe(true)
    expect(orders.listOrders({ customer_id: customer, offset: 61, limit: 25 })).toEqual([])
  })
  it('filters a chat before paging and combines chat/customer restrictions', () => {
    for (const filters of [{ chat_id: 'chat-A' }, { customer_id: customer, chat_id: 'chat-A' }]) {
      const pages = [0, 10, 20].flatMap(offset => orders.listOrders({ ...filters, offset, limit: 10 }))
      expect(pages).toHaveLength(30); expect(new Set(pages.map(order => order.id)).size).toBe(30)
      expect(pages.every(order => order.chat_id === 'chat-A' && order.id.startsWith('old-'))).toBe(true)
    }
  })
})
