import { describe, expect, it } from 'vitest'
import { OVERALL_TEXT, type SystemStatus, type TillReport, ago, bytesText, overallLevel, statusLines } from './systemStatusModel'

const now = Date.parse('2026-11-23T12:00:00.000Z')
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
const GB = 1024 ** 3

const report = (extra: Partial<TillReport> = {}): TillReport => ({
  version: '0.1.0', release_id: '20261123T113640-dc2cc67e', built_at: minutesAgo(600), mode: 'background', role: 'main',
  disk_free_bytes: 120 * GB, disk_total_bytes: 500 * GB, database_bytes: 180 * 1024 ** 2,
  local_backup_at: minutesAgo(40), cloud_backup_at: minutesAgo(180), external_backup_at: minutesAgo(60 * 20),
  schema_version: 28, started_at: minutesAgo(300), check_at: minutesAgo(540), check_findings: [], ...extra,
})
const status = (extra: Partial<SystemStatus['till']> = {}, errors: SystemStatus['errors'] = { last_day: 0, rows: [] }): SystemStatus => ({
  server: { build: 'abc12345', time: new Date(now).toISOString() },
  till: { seen_at: minutesAgo(0.3), online: true, offline_minutes: 0, outbox: { waiting: 0, oldest_at: null, error: null, reported_at: minutesAgo(1) }, report: report(), reported_at: minutesAgo(3), ...extra },
  errors,
})
const line = (lines: ReturnType<typeof statusLines>, id: string) => lines.find(item => item.id === id)!

// 23.11.2026 (план T2): «Стан системи» — простими словами, з телефона.
describe('system status for the owner', () => {
  it('everything fine reads as «Усе працює»: on link, in the background, all sent, fresh copies, enough disk', () => {
    const lines = statusLines(status(), now)
    expect(overallLevel(lines)).toBe('ok')
    expect(OVERALL_TEXT.ok).toBe('Усе працює')
    expect(line(lines, 'link').value).toBe('на звʼязку')
    expect(line(lines, 'mode').value).toBe('працює у фоні (вікно закрите)')
    expect(line(lines, 'version').value).toBe('0.1.0 · 20261123T113640-dc2cc67e')
    expect(line(lines, 'outbox').value).toBe('усе передано')
    expect(line(lines, 'backup-cloud')).toMatchObject({ value: '3 год тому', level: 'ok' })
    expect(line(lines, 'disk')).toMatchObject({ value: '120,0 ГБ', level: 'ok', hint: 'база займає 180 МБ' })
    expect(line(lines, 'errors')).toMatchObject({ value: 'не було', level: 'ok' })
  })

  it('a till that went silent is the main trouble, with a plain hint what to check', () => {
    const lines = statusLines(status({ seen_at: minutesAgo(95), online: false, offline_minutes: 95 }), now)
    expect(line(lines, 'link')).toMatchObject({ level: 'bad', value: 'не на звʼязку — 1 год тому' })
    expect(line(lines, 'link').hint).toContain('лише для перегляду')
    expect(overallLevel(lines)).toBe('bad')
    expect(statusLines(status({ seen_at: null, online: false, offline_minutes: null }), now)[0]).toMatchObject({ level: 'bad', value: 'ще не виходив на звʼязок' })
  })

  it('documents stuck in the queue: a warning after half an hour, trouble when there is an error', () => {
    const waiting = (minutes: number, error: string | null = null) =>
      line(statusLines(status({ outbox: { waiting: 4, oldest_at: minutesAgo(minutes), error, reported_at: minutesAgo(1) } }), now), 'outbox')
    expect(waiting(5)).toMatchObject({ level: 'ok', value: 'чекає документів: 4, найстаріший — 5 хв тому' })
    expect(waiting(45).level).toBe('warn')
    expect(waiting(5, 'Недостатньо прав')).toMatchObject({ level: 'bad', hint: 'Недостатньо прав' })
  })

  it('an old copy of the database and a full disk are flagged; no copy at all is trouble', () => {
    const lines = statusLines(status({ report: report({ cloud_backup_at: minutesAgo(60 * 50), local_backup_at: null, external_backup_at: null, disk_free_bytes: 5 * GB }) }), now)
    expect(line(lines, 'backup-cloud')).toMatchObject({ level: 'warn', value: '2 дн тому' })
    expect(line(lines, 'backup-local')).toMatchObject({ level: 'bad', value: 'копій ще не було' })
    // Флешка — за бажанням власника: її відсутність не робить стан «бідою».
    expect(line(lines, 'backup-external')).toMatchObject({ level: 'unknown', value: 'не налаштовано' })
    expect(line(lines, 'disk').level).toBe('warn')
    expect(line(statusLines(status({ report: report({ disk_free_bytes: GB }) }), now), 'disk').level).toBe('bad')
    expect(line(statusLines(status({ report: report({ cloud_backup_at: minutesAgo(60 * 24 * 9) }) }), now), 'backup-cloud').level).toBe('bad')
  })

  it('what is not known is said so and never shown as fine (an old till program reports nothing)', () => {
    const lines = statusLines(status({ report: null, reported_at: null, outbox: null }), now)
    expect(line(lines, 'report')).toMatchObject({ level: 'unknown', value: 'відомостей ще немає' })
    expect(line(lines, 'outbox').level).toBe('unknown')
    expect(lines.some(item => item.id === 'disk')).toBe(false)
    expect(overallLevel(lines)).toBe('unknown')
    expect(line(statusLines(status({ report: report({ disk_free_bytes: null, release_id: null, version: null }) }), now), 'disk')).toMatchObject({ level: 'unknown', value: 'невідомо' })
  })

  it('server errors of the last day are counted and shown', () => {
    const errors = { last_day: 3, rows: [{ created_at: minutesAgo(10), source: 'sync', route: 'POST /api/v1/till-device/sync/push', code: '0A000', message: 'FOR UPDATE is not allowed with GROUP BY', repeats: 3 }] }
    const lines = statusLines(status({}, errors), now)
    expect(line(lines, 'errors')).toMatchObject({ value: '3', level: 'warn' })
    expect(overallLevel(lines)).toBe('warn')
    expect(line(statusLines(status({}, { ...errors, last_day: 25 }), now), 'errors').level).toBe('bad')
  })

  it('times and sizes are in plain words', () => {
    expect(ago(minutesAgo(0.2), now)).toBe('щойно')
    expect(ago(minutesAgo(59), now)).toBe('59 хв тому')
    expect(ago(minutesAgo(60 * 47), now)).toBe('47 год тому')
    expect(ago(minutesAgo(60 * 24 * 3), now)).toBe('3 дн тому')
    expect(ago(null, now)).toBe('невідомо')
    expect(ago('not a date', now)).toBe('невідомо')
    expect(bytesText(null)).toBe('невідомо')
    expect(bytesText(300 * 1024 ** 2)).toBe('300 МБ')
    expect(bytesText(1.5 * GB)).toBe('1,5 ГБ')
  })
})
