import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TillDeviceLink, type TillDeviceLinkDeps } from '../src/link/tillDeviceLink'
import { STATUS_REPORT_EVERY_MS } from '../src/link/statusReport'

const DEVICE = '00000000-0000-4000-8000-000000000004'
const report = { version: '0.1.0', mode: 'background', role: 'main' }

function harness(over: Partial<TillDeviceLinkDeps> = {}) {
  const bodies: any[] = []
  let now = 1_000_000
  let beatOk = true
  const deps: TillDeviceLinkDeps = {
    fetch: async (url, init) => {
      if (url.endsWith('/beat')) {
        bodies.push(JSON.parse(init.body))
        if (!beatOk) throw new Error('offline')
        return { ok: true, status: 200, json: async () => ({ data: { rpc: false, commands: false, web_active: false } }) }
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }) }
    },
    apiUrl: () => 'https://server.example/', deviceId: () => DEVICE, readKey: () => ({ token: 'k'.repeat(43), tenant_id: 't' }),
    writeKey: () => undefined, execute: async () => 'done', canRun: () => true,
    setTimer: () => 1, clearTimer: () => undefined, sleep: async () => undefined, now: () => now,
    statusReport: () => report,
    ...over,
  }
  const real = new TillDeviceLink(deps)
  let started = false
  // Перше «я на зв'язку» йде при запуску зв'язку, наступні — за сигналом.
  const link = {
    wake: async () => {
      if (started) { await real.wake(); return }
      started = true; real.start()
      for (let i = 0; i < 30; i++) await Promise.resolve()
    },
    stop: () => real.stop(),
  }
  return { link, bodies, advance: (ms: number) => { now += ms }, online: (value: boolean) => { beatOk = value } }
}

// 23.11.2026 (план T2): головний ПК раз на кілька хвилин розповідає серверу про себе — для «Стан системи» у вебі власника.
describe('the till tells the server about itself with its «I am on link»', () => {
  it('the first heartbeat carries the report; the next ones are light until five minutes pass', async () => {
    const h = harness()
    await h.link.wake()
    expect(h.bodies[0]).toEqual({ status: report })
    h.advance(30_000); await h.link.wake()
    expect(h.bodies[1]).toEqual({})
    h.advance(STATUS_REPORT_EVERY_MS); await h.link.wake()
    expect(h.bodies[2]).toEqual({ status: report })
    h.link.stop()
  })

  it('a report that did not reach the server is sent again with the next heartbeat', async () => {
    const h = harness()
    h.online(false); await h.link.wake()
    h.online(true); h.advance(30_000); await h.link.wake()
    expect(h.bodies.map(body => Boolean(body.status))).toEqual([true, true])
    h.advance(30_000); await h.link.wake()
    expect(h.bodies[2]).toEqual({})
    h.link.stop()
  })

  it('goes together with the queue state, and a failed read of the computer never stops the link', async () => {
    const both = harness({ outboxSummary: () => ({ waiting: 2, oldest_at: null, error: null }) })
    await both.link.wake()
    expect(both.bodies[0]).toEqual({ outbox: { waiting: 2, oldest_at: null, error: null }, status: report })
    both.link.stop()
    const broken = harness({ statusReport: () => { throw new Error('disk gone') } })
    await broken.link.wake()
    expect(broken.bodies).toEqual([{}])
    broken.link.stop()
    const none = harness({ statusReport: undefined })
    await none.link.wake()
    expect(none.bodies).toEqual([{}])
    none.link.stop()
  })

  it('the main PC reads only facts about the computer: build, window or background, disk, copies', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    const source = main.slice(main.indexOf('statusReport: () => {'), main.indexOf('canRun: () => isMainTill() && !databaseMaintenance'))
    expect(source).toContain('build: desktopBuildInfo, background: backgroundMode, managerPc: false')
    expect(source).toContain('statfsSync(db.dataRoot)')
    expect(source).toContain('SELECT MAX(cloud_completed_at) AS at FROM shift_backups')
    // Жодних таблиць товарів, клієнтів чи продажів у цьому повідомленні.
    for (const table of ['customers', 'products', 'sales', 'orders', 'staff_users']) expect(source).not.toContain(table)
    const server = readFileSync(new URL('../../../server/src/routes/tillDevice.ts', import.meta.url), 'utf8')
    expect(server).toContain('if (req.body?.status) void saveStatusReport(req.tillDevice!.tenant_id, req.body.status).catch(() => undefined)')
  })
})
