import { syncFunctionBody, syncModuleSource as source } from './helpers/syncSource.js'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const keysetSource = readFileSync(new URL('../syncKeyset.ts', import.meta.url), 'utf8')

describe('desktop sync cursor safety', () => {
  it('uses database time for one immutable request upper bound', () => {
    expect(source).toContain('async function captureSyncState')
    expect(source).toContain('clock_timestamp() AS server_now')
    expect(source).not.toContain("(error as { code?: string } | null)?.code === '42P01'")
    expect(source).not.toContain('Date.now() - CURSOR_OVERLAP_MS')

    const pull = syncFunctionBody('getSyncChanges')
    expect(pull.indexOf('const syncState = await captureSyncState')).toBeLessThan(pull.indexOf('await Promise.all'))
    expect(pull).toContain('upperBound: nextCursor')
  })

  it('pages by timestamp and id without OFFSET drift', () => {
    expect(keysetSource).toContain('buildTimestampKeysetFilter')
    expect(keysetSource).toContain('`${timestampColumn}.gt.${timestamp},and(')
    expect(keysetSource).toContain('.lte(options.timestampColumn, options.upperBound)')
    expect(keysetSource).toContain('.order(options.timestampColumn, { ascending: true })')
    expect(keysetSource).toContain('.order(tieBreaker, { ascending: true })')

    const pullAndBootstrap = syncFunctionBody('getSyncChanges') + syncFunctionBody('getBootstrapSnapshot')
    expect(pullAndBootstrap).not.toContain('.range(')
    expect(pullAndBootstrap).toContain('fetchAllByTimestamp')
    expect(pullAndBootstrap).toContain('fetchAllById')
  })

  it('does not truncate full salary and reserve snapshots to the incremental cursor', () => {
    const secondary = syncFunctionBody('fetchSecondarySyncData')
    expect(secondary).toContain('const changed = (buildQuery: () => any, fullSnapshot = false)')
    expect(secondary).toContain('lowerBound: fullSnapshot ? undefined : since')
    expect(secondary).toMatch(/salary_payments[\s\S]*?fullSnapshots,/)
    expect(secondary).toMatch(/inventory_reserves[\s\S]*?fullSnapshots,/)
    expect(secondary).not.toContain('fullSnapshots ? undefined : since')
    expect(secondary).toContain("if (historySince) query = query.gte('created_at', historySince)")
    expect(secondary).toContain('}, Boolean(historySince))')
  })

  it('restamps every product and counted row at the end of a large inventory transaction', () => {
    const inventory = syncFunctionBody('applyInventoryCompleted')
    const loop = inventory.indexOf('for (const item of items)')
    const productTouch = inventory.indexOf('UPDATE products SET updated_at = clock_timestamp()')
    const itemTouch = inventory.indexOf('UPDATE inventory_items SET updated_at = clock_timestamp()')
    const completed = inventory.indexOf('UPDATE inventory_sessions', itemTouch)
    expect(loop).toBeGreaterThanOrEqual(0)
    expect(productTouch).toBeGreaterThan(loop)
    expect(itemTouch).toBeGreaterThan(productTouch)
    expect(completed).toBeGreaterThan(itemTouch)
  })

  it('captures the bounded bootstrap cursor before reading the snapshot', () => {
    const bootstrap = syncFunctionBody('getBootstrapSnapshot')
    const cursor = bootstrap.indexOf('const snapshotCursor = syncState.cursor')
    const queries = bootstrap.indexOf('await Promise.all')
    expect(cursor).toBeGreaterThanOrEqual(0)
    expect(cursor).toBeLessThan(queries)
    expect(bootstrap).toContain('upperBound: snapshotCursor')
    expect(bootstrap).toContain('exported_at: snapshotCursor')
  })
})