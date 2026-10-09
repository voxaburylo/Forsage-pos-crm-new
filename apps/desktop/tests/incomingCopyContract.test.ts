import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { createSupplierCatalogManifest } from '../src/lib/supplierCatalogManifest'
import { assertIncomingCopyContract, assertIncomingCopyContinuity } from '../src/repositories/incomingCopyContract'
import { assertLocalDataAuthority } from '../src/security/localDataAuthority'

const at = '2026-10-09T10:00:00.000000Z', later = '2026-10-09T11:00:00.000000Z'
let db: LocalDatabase, root: string
const fixture = (cursor = later, since: string | null = null): any => {
  const items = [{ id: 'price', tenant_id: tenant, sku: 'FILTER', name: 'Filter', qty: '2', price_kopecks: 12000 }]
  const imports: any[] = []
  return { tenant_id: tenant, cursor, exported_at: cursor, reset_required: false, reset_generation: 0,
    supplier_price_items: items, supplier_price_imports: imports,
    supplier_catalog_copy: createSupplierCatalogManifest(tenant, cursor, items, imports, since) }
}
const snap = () => JSON.stringify(['app_meta','sync_state','products','supplier_price_items','supplier_price_imports','sync_outbox']
  .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()))
function saved(cursor: string | null) {
  db.prepare('INSERT INTO sync_state(scope,pull_cursor,updated_at) VALUES(?,?,?)').run('desktop_server_pull',cursor,at)
}
function check(input: any, kind: 'pull' | 'bootstrap' = 'pull') {
  const result = assertIncomingCopyContract(input, kind, tenant)
  assertIncomingCopyContinuity(db, result)
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'forsage-incoming-contract-test-'))
  db = new LocalDatabase(root)
})
afterEach(() => {
  db.close()
  if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('forsage-incoming-contract-test-')) {
    rmSync(root, { recursive: true, force: true })
  }
})
it.each(['pull','bootstrap'] as const)('accepts current full %s without changing any database row', kind => {
  const before = snap()
  expect(() => check(fixture(), kind)).not.toThrow()
  expect(snap()).toBe(before)
})
it.each(['pull','bootstrap'] as const)('requires an explicit control manifest for %s', kind => {
  const input = fixture(); delete input.supplier_catalog_copy
  const before = snap()
  expect(() => check(input, kind)).toThrow('контрольного опису')
  expect(snap()).toBe(before)
})
const invalidVersions: unknown[] = [undefined, null, '1', 0, 2, -1, 1.5, NaN, Infinity, {}, true]
it.each(invalidVersions)('rejects unsupported manifest version %#', version => {
  const input = fixture(); input.supplier_catalog_copy.version = version
  expect(() => check(input)).toThrow('контрольного опису')
})
it.each([undefined, null, '', 'other', 123])('does not infer a missing or foreign tenant %#', other => {
  const input = fixture(); input.tenant_id = other
  expect(() => check(input)).toThrow('Несумісна')
})
it('rejects a correctly checksummed copy from a different store', () => {
  const input = fixture()
  input.tenant_id = 'other'
  input.supplier_price_items[0].tenant_id = 'other'
  input.supplier_catalog_copy = createSupplierCatalogManifest('other', later, input.supplier_price_items, [])
  expect(() => check(input)).toThrow()
})
it.each([undefined, null, '', '2026-10-09', '2026-02-30T10:00:00Z', '2026-10-09T24:00:00Z', '2026-10-09T10:00:00.1234567Z'])
('rejects missing or malformed cursor %# before a write', value => {
  const input = fixture(); input.cursor = value; input.exported_at = value
  const before = snap()
  expect(() => check(input)).toThrow()
  expect(() => check(input, 'bootstrap')).toThrow()
  expect(snap()).toBe(before)
})
it.each([true, 'false', 1, null, undefined])('never accepts remote reset signal %#', flag => {
  const input = fixture(); input.reset_required = flag
  const before = snap()
  expect(() => check(input)).toThrow(flag === true ? 'очищення' : 'Несумісна')
  expect(snap()).toBe(before)
})
it.each([-1, '0', 0.5, NaN, Infinity, null, undefined])('rejects malformed generation %#', generation => {
  const input = fixture(); input.reset_generation = generation
  expect(() => check(input)).toThrow()
})
it.each(['rows', 'history', 'price', 'cursor'])('rejects altered catalog %s', fault => {
  const input = fixture()
  if (fault === 'rows') input.supplier_price_items = []
  if (fault === 'history') delete input.supplier_price_imports
  if (fault === 'price') input.supplier_price_items[0].price_kopecks++
  if (fault === 'cursor') input.supplier_catalog_copy.cursor = at
  expect(() => check(input)).toThrow()
})
it('requires a full bootstrap even when the delta is correctly checksummed', () => {
  saved(at)
  const input = fixture(later, at)
  expect(() => check(input, 'bootstrap')).toThrow('Початкова копія має бути повною')
})
it.each([undefined, null])('rejects a delta without previous cursor %#', previous => {
  if (previous === null) saved(null)
  expect(() => check(fixture(later, at))).toThrow('проміжок')
})
it.each(['2026-10-09T10:00:00.000001Z','2026-10-09T10:01:00Z'])('rejects unreceived delta gap from %s', since => {
  saved(at)
  const before = snap()
  expect(() => check(fixture(later, since))).toThrow('проміжок')
  expect(snap()).toBe(before)
})
it.each([at,'2026-10-09T09:59:59Z','2026-10-09T12:00:00+02:00'])('allows contiguous or overlapping retry from %s', since => {
  saved(at)
  expect(() => check(fixture(later,since))).not.toThrow()
})
it.each(['pull','bootstrap'] as const)('refuses a %s cursor moving backwards', kind => {
  saved(later)
  const before = snap()
  expect(() => check(fixture(at),kind)).toThrow('старіша')
  expect(snap()).toBe(before)
})
it('detects cursor regression shorter than one millisecond', () => {
  saved('2026-10-09T10:00:00.000002Z')
  expect(() => check(fixture('2026-10-09T10:00:00.000001Z'))).toThrow('старіша')
})
it('rejects since after cursor at microsecond precision even when legacy digest permits it', () => {
  const input = fixture('2026-10-09T10:00:00.000001Z','2026-10-09T10:00:00.000002Z')
  expect(() => check(input)).toThrow('Несумісна')
})
it('allows an equal cursor for idempotent replay', () => {
  saved(at)
  expect(() => check(fixture(at))).not.toThrow()
})
it('rejects corrupt saved progress instead of silently treating it as a fresh store', () => {
  saved('bad')
  expect(() => check(fixture())).toThrow('Несумісна')
})
it('rejects a changed generation even if the reset flag says false', () => {
  const input = fixture(); input.reset_generation = 1
  const before = snap()
  expect(() => check(input)).toThrow('збереженій версії')
  expect(snap()).toBe(before)
})
it.each(['null','"0"','bad','-1'])('rejects corrupt saved generation %s', value => {
  db.prepare("INSERT INTO app_meta(key,value_json,updated_at) VALUES('desktop_server_reset_generation',?,?)").run(value,at)
  const before = snap()
  expect(() => check(fixture())).toThrow('Несумісна')
  expect(snap()).toBe(before)
})
it('accepts the same explicitly established generation', () => {
  db.prepare("INSERT INTO app_meta(key,value_json,updated_at) VALUES('desktop_server_reset_generation','2',?)").run(at)
  const input = fixture(); input.reset_generation = 2
  expect(() => check(input)).not.toThrow()
})
it('does not grant either incoming channel permission', () => {
  for (const channel of ['desktop:sync:apply-pull-changes','desktop:bootstrap:import-snapshot']) {
    expect(() => assertLocalDataAuthority(channel)).toThrow('заборонено')
  }
})
