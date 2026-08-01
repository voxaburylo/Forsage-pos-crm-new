import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMock = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
}))

vi.mock('../../db/pg.js', () => ({
  pool: {
    options: { max: 4 },
    connect: pgMock.connect,
    query: pgMock.query,
  },
}))

import { acquireTenantMutationGuard, withTenantSyncGenerationGuard } from '../syncGeneration.js'

function fakeClient(resettingAt: string | null = null) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT generation, reset_at')) {
        return {
          rows: [{ generation: 0, reset_at: null, resetting_at: resettingAt }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
}

describe('sync generation guard pool safety', () => {
  beforeEach(() => {
    pgMock.connect.mockReset()
    pgMock.query.mockReset()
    pgMock.connect.mockImplementation(async () => fakeClient())
  })

  it('reserves half the pool for business transactions while guards are active', async () => {
    const releases: Array<() => void> = []
    const work = vi.fn(() => new Promise<string>((resolve) => releases.push(() => resolve('ok'))))

    const tasks = Array.from({ length: 4 }, () => withTenantSyncGenerationGuard('tenant-a', 0, work))

    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(2))
    expect(pgMock.connect).toHaveBeenCalledTimes(2)

    releases.splice(0).forEach((release) => release())
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(4))
    releases.splice(0).forEach((release) => release())

    const results = await Promise.all(tasks)
    expect(results.every((result) => result.matched)).toBe(true)
    expect(pgMock.connect).toHaveBeenCalledTimes(4)
  })

  it('holds the tenant row lock until an ordinary mutation response is finished', async () => {
    const client = fakeClient()
    pgMock.connect.mockResolvedValueOnce(client)

    const release = await acquireTenantMutationGuard('tenant-a')
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('FOR SHARE'))).toBe(true)
    expect(client.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false)

    await release()
    expect(client.query).toHaveBeenCalledWith('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('rejects a mutation with 503 while tenant reset maintenance is active', async () => {
    const client = fakeClient('2026-08-01T12:00:00.000Z')
    pgMock.connect.mockResolvedValueOnce(client)

    await expect(acquireTenantMutationGuard('tenant-a')).rejects.toMatchObject({
      code: 'TENANT_RESET_IN_PROGRESS',
      status: 503,
    })
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
    expect(client.release).toHaveBeenCalledOnce()
  })
})
