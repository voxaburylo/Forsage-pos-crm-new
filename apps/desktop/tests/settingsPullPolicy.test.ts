import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { DEFAULT_TENANT_ID } from '../src/db/localTypes'
import { MAX_OUTBOX_ATTEMPTS } from '../src/repositories/outboxPolicy'
import { LocalSyncRepository } from '../src/repositories/syncRepository'

describe('desktop settings pull conflict policy', () => {
  let root = ''
  let db: LocalDatabase
  let repository: LocalSyncRepository

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'forsage-settings-pull-'))
    db = new LocalDatabase(root)
    repository = new LocalSyncRepository(db)
  })

  afterEach(() => {
    db.close()
    if (root.startsWith(tmpdir()) && path.basename(root).startsWith('forsage-settings-pull-')) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function storeSettings(settings: Record<string, unknown>): void {
    db.prepare(`
      INSERT INTO app_meta(key, value_json, updated_at)
      VALUES ('shop_settings', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(JSON.stringify(settings), new Date().toISOString())
  }

  function readSettings(): Record<string, unknown> {
    const row = db.prepare("SELECT value_json FROM app_meta WHERE key = 'shop_settings'")
      .get() as { value_json: string }
    return JSON.parse(row.value_json) as Record<string, unknown>
  }

  function insertSettingsOutbox(
    payloadJson: string,
    status: 'pending' | 'failed',
    attempts: number,
  ): void {
    db.prepare(`
      INSERT INTO sync_outbox (
        operation_id, tenant_id, device_id, aggregate_type, aggregate_id,
        operation_type, payload_json, status, attempts, created_at
      ) VALUES (?, ?, ?, 'settings', 'shop', 'settings.updated', ?, ?, ?, ?)
    `).run(
      randomUUID(),
      DEFAULT_TENANT_ID,
      db.deviceId,
      payloadJson,
      status,
      attempts,
      new Date().toISOString(),
    )
  }

  function pullSettings(settings: Record<string, unknown>): void {
    repository.applyPullChanges({
      tenant_id: DEFAULT_TENANT_ID,
      cursor: `${new Date().toISOString()}-${randomUUID()}`,
      shop_settings: settings,
    })
  }

  it('preserves only keys from a retryable failed settings update', () => {
    storeSettings({
      id: 'local-shop',
      shop_phone: 'local-phone',
      label_settings: { source: 'local' },
    })
    insertSettingsOutbox(
      JSON.stringify({ shop_phone: 'local-phone' }),
      'failed',
      MAX_OUTBOX_ATTEMPTS - 1,
    )

    pullSettings({
      shop_phone: 'server-phone',
      label_settings: { source: 'server' },
    })

    expect(readSettings()).toEqual({
      id: 'local-shop',
      shop_phone: 'local-phone',
      label_settings: { source: 'server' },
    })
  })

  it('preserves all local settings for a corrupt retryable payload', () => {
    const stored = {
      id: 'local-shop',
      shop_phone: 'local-phone',
      label_settings: { source: 'local' },
    }
    storeSettings(stored)
    insertSettingsOutbox('{broken', 'pending', 0)

    pullSettings({
      shop_phone: 'server-phone',
      label_settings: { source: 'server' },
    })

    expect(readSettings()).toEqual(stored)
  })

  it('keeps local settings while a stuck but readable change is still queued', () => {
    // Вичерпані спроби більше не означають смерть операції: каса повертається
    // до неї сама. Тому серверна версія не має права затерти зміну, яка ще поїде.
    const stored = {
      id: 'local-shop',
      shop_phone: 'local-phone',
      label_settings: { source: 'local' },
    }
    storeSettings(stored)
    insertSettingsOutbox(JSON.stringify({ shop_phone: 'local-phone' }), 'failed', MAX_OUTBOX_ATTEMPTS)

    pullSettings({ shop_phone: 'server-phone', label_settings: { source: 'server' } })

    expect(readSettings().shop_phone).toBe('local-phone')
  })

  it('lets the server become canonical after a failed row reaches the retry limit', () => {
    storeSettings({
      id: 'local-shop',
      shop_phone: 'local-phone',
      label_settings: { source: 'local' },
    })
    insertSettingsOutbox('{broken', 'failed', MAX_OUTBOX_ATTEMPTS)

    pullSettings({
      shop_phone: 'server-phone',
      label_settings: { source: 'server' },
    })

    expect(readSettings()).toEqual({
      id: 'local-shop',
      shop_phone: 'server-phone',
      label_settings: { source: 'server' },
    })
  })
})
