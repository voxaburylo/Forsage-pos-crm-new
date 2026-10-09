import { isDeepStrictEqual } from 'node:util'
import type { LocalDatabase } from '../db/localDatabase'
import { SERVER_RESET_GENERATION_KEY } from './localTenantReset'

export const SERVER_PULL_SCOPE = 'desktop_server_pull'
export const LAST_REFERENCE_SYNC_KEY = 'desktop_last_reference_sync_at'
const conflict = () => new Error('Не вдалося підтвердити завершення копіювання. Цю спробу не завершено; повторіть синхронізацію.')

type Completion = {
  cursor: string
  appliedAt: string
  referencesIncluded?: boolean
  bootstrap?: boolean
  counts?: Record<string, number>
  resetGeneration?: number
}
/** Must share the enclosing transaction with the data it acknowledges. */
export function writePullCompletion(db: LocalDatabase, input: Completion): void {
  db.transaction(() => {
    const before = Number((db.prepare('SELECT total_changes() n').get() as { n: number }).n)
    const expectedState = {
      scope: SERVER_PULL_SCOPE, pull_cursor: input.cursor,
      last_attempt_at: input.appliedAt, last_success_at: input.appliedAt,
      last_error: null, updated_at: input.appliedAt,
    }
    let writes = 0
    const checked = (changes: number | bigint) => {
      if (Number(changes) !== 1) throw conflict()
      writes++
    }
    checked(db.prepare(`
      INSERT INTO sync_state(scope,pull_cursor,last_attempt_at,last_success_at,last_error,updated_at)
      VALUES(?,?,?,?,NULL,?)
      ON CONFLICT(scope) DO UPDATE SET pull_cursor=excluded.pull_cursor,
        last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,
        last_error=NULL,updated_at=excluded.updated_at
    `).run(SERVER_PULL_SCOPE,input.cursor,input.appliedAt,input.appliedAt,input.appliedAt).changes)

    const meta: Array<{ key: string; value_json: string; updated_at: string }> = []
    const add = (key: string, value: unknown) => meta.push({ key, value_json: JSON.stringify(value), updated_at: input.appliedAt })
    if (input.referencesIncluded) add(LAST_REFERENCE_SYNC_KEY, input.appliedAt)
    if (Number.isSafeInteger(input.resetGeneration)) add(SERVER_RESET_GENERATION_KEY, Math.max(0, input.resetGeneration!))
    if (input.bootstrap) add('last_bootstrap_snapshot', { exported_at: input.cursor, counts: input.counts ?? {} })
    for (const row of meta) checked(db.prepare(`
      INSERT INTO app_meta(key,value_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at
    `).run(row.key,row.value_json,row.updated_at).changes)

    const after = Number((db.prepare('SELECT total_changes() n').get() as { n: number }).n)
    if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after) || after - before !== writes) throw conflict()
    const state = db.prepare('SELECT * FROM sync_state WHERE scope=?').get(SERVER_PULL_SCOPE)
    if (!state || !isDeepStrictEqual({ ...state }, expectedState)) throw conflict()
    for (const row of meta) {
      const stored = db.prepare('SELECT * FROM app_meta WHERE key=?').get(row.key)
      if (!stored || !isDeepStrictEqual({ ...stored }, row)) throw conflict()
    }
  })
}
