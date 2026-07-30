import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../syncService.ts', import.meta.url), 'utf8')

describe('desktop sync cursor safety', () => {
  it('uses a deterministic final order and supports composite-key journals', () => {
    const fetchAllSource = source.slice(
      source.indexOf('async function fetchAll'),
      source.indexOf('function withChangedSince'),
    )

    expect(fetchAllSource).toContain("tieBreaker = 'id'")
    expect(fetchAllSource).toContain("query.order(tieBreaker, { ascending: true })")
    expect(source.match(/}, 'entity_id'\)/g)).toHaveLength(3)
  })
  it('captures the bootstrap cursor before reading the snapshot', () => {
    const bootstrapSource = source.slice(
      source.indexOf('export async function getBootstrapSnapshot'),
      source.indexOf('export async function pushLocalOperations'),
    )
    const cursor = bootstrapSource.indexOf('const snapshotCursor')
    const queries = bootstrapSource.indexOf('await Promise.all')
    const returnedCursor = bootstrapSource.indexOf('exported_at: snapshotCursor')

    expect(cursor).toBeGreaterThanOrEqual(0)
    expect(cursor).toBeLessThan(queries)
    expect(returnedCursor).toBeGreaterThan(queries)
    expect(bootstrapSource).not.toContain('exported_at: new Date().toISOString()')
  })
})
