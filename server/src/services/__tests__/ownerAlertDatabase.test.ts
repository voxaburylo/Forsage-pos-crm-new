import { describe, expect, it, vi } from 'vitest'
vi.mock('../../db/pg.js', () => ({ pool: { query: vi.fn() } }))
vi.mock('../../db/supabase.js', () => ({ db: {} }))
import { databaseSlowAlert, DB_ALERT_PROBE_MS } from '../ownerAlertDatabase.js'
import { planOwnerAlerts, type OwnerAlertFacts } from '../ownerAlertService.js'
import { DB_SLOW_PROBE_MS, DB_STUCK_QUERIES } from '../dbLoad.js'

// 27.11.2026: база гальмувала шість годин, і першим про це написав сайт. Тепер власник дізнається з Telegram.
const at = (time: string) => new Date(`2026-11-27T${time}:00+02:00`)
const facts = (over: Partial<OwnerAlertFacts> = {}): OwnerAlertFacts =>
  ({ till_seen_at: null, open_shifts: [], closed_shifts: [], negative_products: [], last_backup_at: undefined, ...over })

describe('the owner hears that the cloud database is slow', () => {
  it('a quick database is silent; a short "busy" that only pauses background work is silent too', () => {
    expect(databaseSlowAlert({ probe_ms: 40, stuck: 0 }, '2026-11-27', 10)).toBeNull()
    expect(databaseSlowAlert({ probe_ms: DB_SLOW_PROBE_MS + 100, stuck: 0 }, '2026-11-27', 10)).toBeNull()
    expect(databaseSlowAlert(null, '2026-11-27', 10)).toBeNull()
    expect(databaseSlowAlert(undefined, '2026-11-27', 10)).toBeNull()
  })

  it('a slow answer or several stuck queries give one message with what to check (letter «s» in the data)', () => {
    const slow = databaseSlowAlert({ probe_ms: DB_ALERT_PROBE_MS + 1000, stuck: 0 }, '2026-11-27', 4)!
    expect(slow.text).toContain('відповідала 2,5 с')
    expect(slow.text).toContain('Disk IO Budget')
    expect(slow.text).toContain('Каса на головному ПК працює як завжди')
    const stuck = databaseSlowAlert({ probe_ms: 30, stuck: DB_STUCK_QUERIES }, '2026-11-27', 4)!
    expect(stuck.text).toContain(`зависло запитів: ${DB_STUCK_QUERIES}`)
  })

  it('once per three hours while it lasts', () => {
    const key = (hour: number) => databaseSlowAlert({ probe_ms: 9000, stuck: 5 }, '2026-11-27', hour)!.key
    expect(key(0)).toBe(key(2))
    expect(key(2)).not.toBe(key(3))
    expect(key(3)).toBe(key(5))
    expect(databaseSlowAlert({ probe_ms: 9000, stuck: 5 }, '2026-11-28', 0)!.key).not.toBe(key(0))
  })

  it('goes out with the other alerts, at night as well', () => {
    const night = planOwnerAlerts(facts({ database_load: { probe_ms: 30_000, stuck: 7 } }), at('02:10'))
    expect(night.map(alert => alert.key)).toEqual(['db_slow:2026-11-27:0'])
    expect(planOwnerAlerts(facts({ database_load: { probe_ms: 50, stuck: 0 } }), at('02:10'))).toEqual([])
    expect(planOwnerAlerts(facts(), at('02:10'))).toEqual([])
  })
})
