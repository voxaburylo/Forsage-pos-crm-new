import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Writable } from 'node:stream'
import { afterEach, expect, it } from 'vitest'
import express from 'express'
import { streamSyncJson, syncJsonChunks, SYNC_JSON_CHUNK_CHARS } from './streamSyncJson.js'
import { createSupplierCatalogManifest, validateSupplierCatalogManifest } from './supplierCatalogManifest.js'

let server: Server | undefined
afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = undefined
  }
})
async function listen(data: Record<string, unknown>) {
  const app = express()
  app.get('/', async (_req, res) => {
    try { await streamSyncJson(res, data) }
    catch { if (!res.destroyed) res.destroy() }
  })
  server = createServer(app)
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port
}
const wire = (data: Record<string, unknown>) => Buffer.concat([...syncJsonChunks(data)].map(part => Buffer.from(part))).toString('utf8')

it.each([
  {}, { a: [], b: 1, empty: null }, { a: undefined, b: 'x' },
  { a: [undefined, null, NaN, false, 0, 'quote " newline\n'], b: { when: new Date('2026-10-09') } },
  { a: Array(3), ['__proto__']: { constructor: 'plain data' } },
])('preserves JSON.stringify envelope and field semantics %#', data => {
  expect(wire(data)).toBe(JSON.stringify({ data }))
})
it.each([SYNC_JSON_CHUNK_CHARS - 1, SYNC_JSON_CHUNK_CHARS, SYNC_JSON_CHUNK_CHARS + 1])('preserves UTF-8 across %s boundary', n => {
  const data = { name: 'ж'.repeat(n) + '🛢️𐀀' + 'щ'.repeat(n), rows: ['\ud800', '\udc00'] }
  expect(wire(data)).toBe(JSON.stringify({ data }))
  for (const part of syncJsonChunks(data)) {
    expect(part.length).toBeLessThanOrEqual(SYNC_JSON_CHUNK_CHARS)
    expect(Buffer.byteLength(part)).toBeLessThanOrEqual(SYNC_JSON_CHUNK_CHARS * 3)
  }
})
it('does not split a surrogate pair exactly at the write boundary', () => {
  const prefix = '{"data":{"a":"'
  const data = { a: 'x'.repeat(SYNC_JSON_CHUNK_CHARS - prefix.length - 1) + '😀abc' }
  const chunks = [...syncJsonChunks(data)]
  expect(chunks[0].length).toBe(SYNC_JSON_CHUNK_CHARS - 1)
  expect(chunks[1].startsWith('😀')).toBe(true)
  expect(wire(data)).toBe(JSON.stringify({ data }))
})
it('transmits a complete over-4.5-MB catalog over real HTTP without Content-Length', async () => {
  const tenant = 'shop', cursor = '2026-10-09T10:00:00Z'
  const items = Array.from({ length: 15000 }, (_, i) => ({
    id: 'item-' + i, tenant_id: tenant, sku: 'SKU-' + i, name: 'Фільтр 🛢️ '.repeat(18) + i,
    qty: '0.125', price_kopecks: 12345, updated_at: cursor,
  }))
  const imports = [{ id: 'history', tenant_id: tenant, total_rows: items.length }]
  const data = { tenant_id: tenant, cursor, supplier_price_items: items, supplier_price_imports: imports,
    supplier_catalog_copy: createSupplierCatalogManifest(tenant, cursor, items, imports) }
  const url = await listen(data)
  const response = await fetch(url)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-length')).toBeNull()
  expect(response.headers.get('cache-control')).toContain('no-store')
  expect(response.headers.get('content-type')).toContain('application/json')
  const body = await response.text()
  expect(Buffer.byteLength(body)).toBeGreaterThan(4.5 * 1024 * 1024)
  const downloaded = JSON.parse(body).data
  expect(downloaded.supplier_price_items).toHaveLength(15000)
  expect(downloaded.supplier_price_items[14999].sku).toBe('SKU-14999')
  validateSupplierCatalogManifest(downloaded, tenant, cursor)
})

class SlowResponse extends Writable {
  headers = new Map<string, unknown>()
  chunks: Buffer[] = []
  consumed = 0
  constructor(private readonly stopAfter = Infinity) { super({ highWaterMark: 1 }) }
  setHeader(key: string, value: unknown) { this.headers.set(key, value) }
  removeHeader(key: string) { this.headers.delete(key) }
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(Buffer.from(chunk)); this.consumed++
    setImmediate(() => this.consumed >= this.stopAfter ? callback(new Error('connection lost')) : callback())
  }
}
it('obeys a slow receiver and yields the event loop while keeping exact data', async () => {
  const data = { rows: Array.from({ length: 10000 }, (_, i) => ({ i, name: 'Товар '.repeat(15) })) }
  const res = new SlowResponse()
  let ticks = 0
  const tick = setInterval(() => ticks++, 1)
  try {
    await streamSyncJson(res as any, data)
    expect(Buffer.concat(res.chunks).toString()).toBe(JSON.stringify({ data }))
    expect(res.chunks.length).toBeGreaterThan(50)
    expect(res.chunks.every(chunk => chunk.length <= SYNC_JSON_CHUNK_CHARS * 3)).toBe(true)
    expect(ticks).toBeGreaterThan(0)
  } finally { clearInterval(tick) }
})
it('stops serialization after a lost receiver instead of producing the entire catalog', async () => {
  let serialized = 0
  const data = { rows: Array.from({ length: 10000 }, (_, i) => ({
    get name() { serialized++; return 'Товар '.repeat(25) + i },
  })) }
  const res = new SlowResponse(2)
  await expect(streamSyncJson(res as any, data)).rejects.toThrow('connection lost')
  expect(res.destroyed).toBe(true)
  expect(serialized).toBeLessThan(1000)
  expect(() => JSON.parse(Buffer.concat(res.chunks).toString())).toThrow()
})
it('rejects a receiver already closed before serialization', async () => {
  const res = new SlowResponse()
  res.destroy()
  const data = { get rows() { throw new Error('must not be read') } }
  await expect(streamSyncJson(res as any, data)).rejects.toThrow('SYNC_RESPONSE_CLOSED')
})
it('rejects invalid small JSON before setting headers', async () => {
  const res = new SlowResponse()
  await expect(streamSyncJson(res as any, { invalid: BigInt(1) })).rejects.toThrow()
  expect(res.headers.size).toBe(0)
  expect(res.chunks).toHaveLength(0)
  res.destroy()
})
it('interrupts HTTP on late serialization errors instead of returning a valid partial copy', async () => {
  const url = await listen({ rows: Array.from({ length: 3000 }, (_, i) => ({ name: 'Товар '.repeat(25), i })), invalid: BigInt(1) })
  const response = await fetch(url)
  expect(response.status).toBe(200)
  await expect(response.json()).rejects.toThrow()
})
