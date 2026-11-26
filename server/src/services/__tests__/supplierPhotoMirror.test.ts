import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query } }))
import { GPL_LINK_EVERY_PAGES, SHARED_CROSSES_PER_RUN, SHARED_PHOTOS_PER_RUN, mirrorLinkedPhotosStep } from '../supplierApiService.js'

// 26.11.2026, власник: «так, робіть усі рекомендації» — фото постачальників у наші картки без фото; фото Омеги не чекають кроси.
describe('supplier photos for our cards', () => {
  beforeEach(() => query.mockReset())

  it('copies a GPL photo of a linked offer into our storage (no CORS there for the main PC); a broken one waits 30 days', async () => {
    query.mockImplementation(async (sql: unknown) => String(sql).startsWith('SELECT external_id') ? { rows: [{ external_id: 'A1', image_url: 'https://gpl.example/a.webp' }, { external_id: 'B/2', image_url: 'https://gpl.example/b.txt' }] } : { rows: [] })
    const fetch = vi.fn(async (url: string) => url.endsWith('.webp')
      ? new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/webp' } })
      : new Response('no', { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof globalThis.fetch
    const upload = vi.fn(async (path: string) => 'https://our.storage/' + path)
    expect(await mirrorLinkedPhotosStep({ id: 'c', tenant_id: 't' }, { fetch, upload })).toEqual({ saved: 1, failed: 1 })
    expect(upload).toHaveBeenCalledWith('t/c/A1.webp', expect.any(Buffer), 'image/webp')
    const select = String(query.mock.calls[0][0])
    expect(select).toContain('product_id IS NOT NULL')
    expect(select).toContain('photo_saved_at IS NULL')
    expect(select).toContain("interval '30 days'")
    const updates = query.mock.calls.slice(1).map(call => [String(call[0]), call[1]])
    expect(updates[0][0]).toContain('photo_saved_at = now()')
    expect(updates[0][1]).toEqual(['c', 'A1', 'https://our.storage/t/c/A1.webp'])
    expect(updates[1][0]).toBe('UPDATE supplier_offers SET photo_checked_at = now() WHERE connection_id = $1 AND external_id = $2')
  })

  it('the next price pass does not replace our stored copy with the supplier link again', () => {
    const source = readFileSync(new URL('../supplierApiService.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    expect(source).toContain('image_url = CASE WHEN supplier_offers.photo_saved_at IS NOT NULL THEN supplier_offers.image_url ELSE COALESCE(EXCLUDED.image_url, supplier_offers.image_url) END')
  })

  it('Omega photos share the request limit with crosses (19 a minute, about 230 an hour); GPL links mid-pass', () => {
    expect(SHARED_CROSSES_PER_RUN + SHARED_PHOTOS_PER_RUN + 1).toBeLessThanOrEqual(20)
    expect((SHARED_CROSSES_PER_RUN + SHARED_PHOTOS_PER_RUN + 1) * 12).toBeLessThanOrEqual(250)
    expect(GPL_LINK_EVERY_PAGES).toBe(400)
    const source = readFileSync(new URL('../supplierApiService.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    expect(source).toContain('syncPhotosStep(row, deps, crossesLeft ? SHARED_PHOTOS_PER_RUN : PHOTOS_PER_RUN)')
    expect(source).not.toContain('row.photos_enabled && !crossesLeft')
  })
})
