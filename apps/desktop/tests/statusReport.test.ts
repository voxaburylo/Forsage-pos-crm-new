import { describe, expect, it } from 'vitest'
import { STATUS_REPORT_EVERY_MS, buildStatusReport, statusReportDue } from '../src/link/statusReport'

// 23.11.2026 (план T2): що головний ПК повідомляє про себе для екрана «Стан системи».
describe('till status report', () => {
  it('describes the program and the computer, and nothing about goods, customers or money', () => {
    const report = buildStatusReport({
      build: { version: '0.1.0', releaseId: '20261123T113640-dc2cc67e', builtAt: '2026-11-23T11:36:40.000Z' },
      background: true, managerPc: false, disk: { free: 120_000_000_000, total: 500_000_000_000 }, databaseBytes: 190_000_000,
      localBackupAt: '2026-11-23T09:00:00.000Z', cloudBackupAt: '2026-11-23T08:00:00.000Z', externalBackupAt: null, schemaVersion: 28, startedAt: 1795000000000,
    })
    expect(report).toEqual({
      version: '0.1.0', release_id: '20261123T113640-dc2cc67e', built_at: '2026-11-23T11:36:40.000Z', mode: 'background', role: 'main',
      disk_free_bytes: 120_000_000_000, disk_total_bytes: 500_000_000_000, database_bytes: 190_000_000,
      local_backup_at: '2026-11-23T09:00:00.000Z', cloud_backup_at: '2026-11-23T08:00:00.000Z', external_backup_at: null,
      schema_version: 28, started_at: new Date(1795000000000).toISOString(), check_at: null, check_findings: [],
    })
  })

  it('an open window and a manager PC are named as such', () => {
    expect(buildStatusReport({ background: false, managerPc: true })).toMatchObject({ mode: 'window', role: 'manager' })
  })

  it('what could not be read is «unknown», never a made-up number', () => {
    const report = buildStatusReport({ build: null, background: false, managerPc: false, disk: { free: -1, total: 'many' }, databaseBytes: NaN, localBackupAt: 'yesterday', schemaVersion: 0 })
    expect(report).toEqual({
      version: null, release_id: null, built_at: null, mode: 'window', role: 'main', disk_free_bytes: null, disk_total_bytes: null, database_bytes: null,
      local_backup_at: null, cloud_backup_at: null, external_backup_at: null, schema_version: null, started_at: null, check_at: null, check_findings: [],
    })
    expect(buildStatusReport({ build: { version: 'v'.repeat(300) }, background: false, managerPc: false }).version).toHaveLength(40)
  })

  it('is sent at once the first time and then not more often than every five minutes', () => {
    expect(STATUS_REPORT_EVERY_MS).toBe(5 * 60_000)
    expect(statusReportDue(null, 1000)).toBe(true)
    expect(statusReportDue(1000, 1000 + STATUS_REPORT_EVERY_MS - 1)).toBe(false)
    expect(statusReportDue(1000, 1000 + STATUS_REPORT_EVERY_MS)).toBe(true)
  })
})
