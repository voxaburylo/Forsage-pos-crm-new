import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { runWebCatalogMerge, WEB_MERGE_CHANNELS, WEB_MERGE_NO_WINDOW, WEB_MERGE_SERVER_UNPROVEN, type WebMergeHost } from '../src/repositories/webCatalogMerge'
import { webRpcChannelAllowed } from '../src/lan/webRpcChannels'

// 26.11.2026, власник (скрин з телефона): помічник у вебі запропонував обʼєднати дублі — «Ця дія доступна лише на самій касі».
describe('merging duplicates from the assistant in the web, through the main PC', () => {
  let root: string, db: LocalDatabase, catalog: LocalCatalogRepository
  const tenant = DEFAULT_TENANT_ID
  const owner = { id: '00000000-0000-4000-8000-000000000101', tenant_id: tenant, role: 'owner' }
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-webmerge-'))
    db = new LocalDatabase(root); catalog = new LocalCatalogRepository(db)
    db.prepare('INSERT INTO staff_users(id,tenant_id,full_name,role,phone,is_active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)').run(owner.id, tenant, 'Owner', 'owner', '+380670000000', '2026-10-13', '2026-10-13')
  })
  afterEach(() => { db.close(); if (path.basename(root).startsWith('forsage-webmerge-')) rmSync(root, { recursive: true, force: true }) })
  const serverAcceptedMergeBefore = () => db.prepare(`INSERT INTO sync_outbox(operation_id,tenant_id,device_id,aggregate_type,aggregate_id,operation_type,payload_json,status,created_at,synced_at)
      VALUES(?,?,?,'product',?,'product.catalog_cleanup','{}','synced',?,?)`).run(randomUUID(), tenant, db.deviceId, randomUUID(), '2026-10-13T10:00:00Z', '2026-10-13T10:00:05Z')
  const product = (sku: string, name: string, over: Record<string, unknown> = {}) =>
    catalog.upsertProduct({ id: randomUUID(), sku, name, qty_on_hand: 0, purchase_price: 1000, retail_price: 3000, ...over } as never)
  const host = (over: Partial<WebMergeHost> = {}): WebMergeHost => ({ db, readOpenReceipts: async () => [], backup: vi.fn(async () => 'backup.db'), busy: () => false, lock: vi.fn(), ...over })

  it('owner from the web: preview, then merge — backup first, stock summed, the duplicate archived, written as the owner', async () => {
    serverAcceptedMergeBefore()
    const keep = product('82305', 'Запобіжники (плоскі міні 10A) WTB', { qty_on_hand: 50 })
    const dup = product('111', 'Запобіжники (плоскі міні 10A) WTB', { qty_on_hand: 0 })
    const selection = { target_id: keep.id, source_ids: [dup.id], stock_review: 'pending' }
    const preview = await runWebCatalogMerge(host(), owner, WEB_MERGE_CHANNELS.preview, selection) as { can_apply: boolean; fingerprint: string }
    expect(preview.can_apply).toBe(true)
    const backup = vi.fn(async () => 'C:/backup.db'), lock = vi.fn()
    const result = await runWebCatalogMerge(host({ backup, lock }), owner, WEB_MERGE_CHANNELS.apply,
      { ...selection, operation_id: randomUUID(), preview_fingerprint: preview.fingerprint, reason: 'Дубль за пропозицією ШІ-помічника' }) as { backupPath: string }
    expect(result.backupPath).toBe('C:/backup.db')
    expect(backup).toHaveBeenCalledTimes(1)
    expect(lock.mock.calls.map(call => call[0])).toEqual([true, false])
    expect((db.prepare('SELECT qty_on_hand, deleted_at FROM products WHERE id=?').get(keep.id) as any)).toMatchObject({ qty_on_hand: 50, deleted_at: null })
    expect((db.prepare('SELECT deleted_at FROM products WHERE id=?').get(dup.id) as any).deleted_at).toBeTruthy()
    expect((db.prepare("SELECT user_id FROM audit_log WHERE action='product.catalog_cleanup' ORDER BY sequence DESC LIMIT 1").get() as any).user_id).toBe(owner.id)
  })

  it('refuses: not owner/admin; the till window is closed (open receipts unknown); the server never accepted a merge; another merge running', async () => {
    const a = product('A1', 'Однакова назва'), b = product('A2', 'Однакова назва')
    const selection = { target_id: a.id, source_ids: [b.id], stock_review: 'pending' }
    await expect(runWebCatalogMerge(host(), { ...owner, role: 'manager' }, WEB_MERGE_CHANNELS.preview, selection)).rejects.toThrow('власнику та адміністратору')
    await expect(runWebCatalogMerge(host(), owner, WEB_MERGE_CHANNELS.preview, selection)).rejects.toThrow(WEB_MERGE_SERVER_UNPROVEN)
    serverAcceptedMergeBefore()
    await expect(runWebCatalogMerge(host({ readOpenReceipts: async () => null }), owner, WEB_MERGE_CHANNELS.preview, selection)).rejects.toThrow(WEB_MERGE_NO_WINDOW)
    await expect(runWebCatalogMerge(host({ busy: () => true }), owner, WEB_MERGE_CHANNELS.apply, selection)).rejects.toThrow('ще виконується')
    await expect(runWebCatalogMerge(host(), owner, WEB_MERGE_CHANNELS.apply, null)).rejects.toThrow('Некоректний запит')
  })

  it('a card in an open receipt at the till blocks the merge from the web too', async () => {
    serverAcceptedMergeBefore()
    const a = product('B1', 'Ще одна назва'), b = product('B2', 'Ще одна назва')
    const receipts = [['forsage_pos_open_receipts_v2:user1', JSON.stringify({ tabs: [{ items: [{ productId: b.id }] }] })]]
    const preview = await runWebCatalogMerge(host({ readOpenReceipts: async () => receipts }), owner, WEB_MERGE_CHANNELS.preview,
      { target_id: a.id, source_ids: [b.id], stock_review: 'pending' }) as { can_apply: boolean; blockers: string[] }
    expect(preview.can_apply).toBe(false)
    expect(preview.blockers.length).toBeGreaterThan(0)
  })

  it('the rest of catalog cleanup stays till-only; the main PC routes only these two actions through the web path', () => {
    expect(webRpcChannelAllowed('desktop:catalog:cleanup-apply-sku')).toBe(false)
    expect(webRpcChannelAllowed('desktop:catalog:cleanup-tidy-apply')).toBe(false)
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(main.indexOf('if (isWebMergeChannel(channel))')).toBeLessThan(main.indexOf("throw new Error('Ця дія доступна лише на самій касі')"))
    const server = readFileSync(new URL('../../../server/src/services/tillRpcService.ts', import.meta.url), 'utf8')
    expect(server).toContain("WEB_MERGE_CHANNELS: readonly string[] = ['desktop:catalog:cleanup-preview', 'desktop:catalog:cleanup-apply']")
  })
})
