import type { PoolClient } from 'pg'
import { pool } from '../db/pg.js'
import { AppError } from '../middleware/errorHandler.js'

export type TenantSyncGeneration = {
  generation: number
  resetAt: string | null
  resettingAt: string | null
}

type GenerationRow = {
  generation: string | number
  reset_at: Date | string | null
  resetting_at: Date | string | null
}

const generationGuardLimit = Math.max(1, Math.floor(Number(pool.options.max ?? 10) / 2))
let activeGenerationGuards = 0
const generationGuardWaiters: Array<() => void> = []

async function acquireGenerationGuardPermit(): Promise<() => void> {
  if (activeGenerationGuards >= generationGuardLimit) {
    await new Promise<void>((resolve) => generationGuardWaiters.push(resolve))
  }
  activeGenerationGuards += 1
  let released = false
  return () => {
    if (released) return
    released = true
    activeGenerationGuards -= 1
    generationGuardWaiters.shift()?.()
  }
}

function timestamp(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const parsed = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
}

function stateFromRow(row: GenerationRow | undefined): TenantSyncGeneration {
  return {
    generation: Number(row?.generation ?? 0),
    resetAt: timestamp(row?.reset_at),
    resettingAt: timestamp(row?.resetting_at),
  }
}

function resetError(state: TenantSyncGeneration): AppError {
  return new AppError(
    'SYNC_RESET_REQUIRED',
    'Локальна копія належить іншому поколінню даних. Оновіть локальну базу перед продажем.',
    409,
    { reset_generation: state.generation, reset_at: state.resetAt },
  )
}

function resetInProgressError(state?: TenantSyncGeneration): AppError {
  return new AppError(
    'TENANT_RESET_IN_PROGRESS',
    'Дані магазину зараз очищуються. Повторіть дію після завершення скидання.',
    503,
    state ? { resetting_at: state.resettingAt } : undefined,
  )
}

export async function getTenantSyncGeneration(tenantId: string): Promise<TenantSyncGeneration> {
  const result = await pool.query<GenerationRow>(
    `SELECT COALESCE(state.generation, 0) AS generation,
            state.reset_at,
            state.resetting_at
     FROM (SELECT 1) AS singleton
     LEFT JOIN sync_tenant_generations AS state ON state.tenant_id = $1`,
    [tenantId],
  )
  return stateFromRow(result.rows[0])
}

export async function assertTenantSyncGeneration(
  tenantId: string,
  clientGeneration: number,
): Promise<TenantSyncGeneration> {
  const state = await getTenantSyncGeneration(tenantId)
  if (state.resettingAt) throw resetInProgressError(state)
  if (clientGeneration !== state.generation) throw resetError(state)
  return state
}

async function lockTenantSyncGeneration(
  client: PoolClient,
  tenantId: string,
): Promise<TenantSyncGeneration> {
  await client.query(
    `INSERT INTO sync_tenant_generations (tenant_id, generation, reset_at, updated_at)
     VALUES ($1, 0, NULL, clock_timestamp())
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId],
  )
  const result = await client.query<GenerationRow>(
    `SELECT generation, reset_at, resetting_at
     FROM sync_tenant_generations
     WHERE tenant_id = $1
     FOR SHARE`,
    [tenantId],
  )
  return stateFromRow(result.rows[0])
}

export async function beginTenantReset(tenantId: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO sync_tenant_generations (tenant_id, generation, reset_at, updated_at)
       VALUES ($1, 0, NULL, clock_timestamp())
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId],
    )
    const result = await client.query(
      `UPDATE sync_tenant_generations
       SET resetting_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND resetting_at IS NULL
       RETURNING tenant_id`,
      [tenantId],
    )
    if (result.rowCount === 0) throw resetInProgressError()
    await client.query('COMMIT')
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* preserve original error */ }
    throw error
  } finally {
    client.release()
  }
}

export async function clearTenantResetMarker(tenantId: string): Promise<void> {
  await pool.query(
    `UPDATE sync_tenant_generations
     SET resetting_at = NULL, updated_at = clock_timestamp()
     WHERE tenant_id = $1`,
    [tenantId],
  )
}

export async function acquireTenantMutationGuard(tenantId: string): Promise<() => Promise<void>> {
  const releasePermit = await acquireGenerationGuardPermit()
  const client = await pool.connect().catch((error) => {
    releasePermit()
    throw error
  })

  try {
    await client.query('BEGIN')
    const state = await lockTenantSyncGeneration(client, tenantId)
    if (state.resettingAt) throw resetInProgressError(state)

    let released = false
    return async () => {
      if (released) return
      released = true
      try {
        await client.query('COMMIT')
      } catch (error) {
        try { await client.query('ROLLBACK') } catch { /* preserve original error */ }
        throw error
      } finally {
        client.release()
        releasePermit()
      }
    }
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* preserve original error */ }
    client.release()
    releasePermit()
    throw error
  }
}

export type TenantSyncGenerationGuardResult<T> =
  | { matched: true; state: TenantSyncGeneration; value: T }
  | { matched: false; state: TenantSyncGeneration }

/**
 * Keeps resetAllData behind a shared row lock while work commits through its
 * own transactions. A reset either finishes first (and the generation no
 * longer matches) or waits and then removes every write from this batch.
 */
export async function withTenantSyncGenerationGuard<T>(
  tenantId: string,
  clientGeneration: number,
  work: (state: TenantSyncGeneration) => Promise<T>,
): Promise<TenantSyncGenerationGuardResult<T>> {
  const releasePermit = await acquireGenerationGuardPermit()
  const client = await pool.connect().catch((error) => {
    releasePermit()
    throw error
  })
  try {
    await client.query('BEGIN')
    const state = await lockTenantSyncGeneration(client, tenantId)
    if (state.resettingAt) throw resetInProgressError(state)
    if (clientGeneration !== state.generation) {
      await client.query('COMMIT')
      return { matched: false, state }
    }

    const value = await work(state)
    await client.query('COMMIT')
    return { matched: true, state, value }
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* preserve the original error */ }
    throw error
  } finally {
    client.release()
    releasePermit()
  }
}

export async function assertTenantSyncGenerationInTransaction(
  client: PoolClient,
  tenantId: string,
  clientGeneration: number,
): Promise<TenantSyncGeneration> {
  const state = await lockTenantSyncGeneration(client, tenantId)
  if (state.resettingAt) throw resetInProgressError(state)
  if (clientGeneration !== state.generation) throw resetError(state)
  return state
}
