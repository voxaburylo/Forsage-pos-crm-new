import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const query = vi.hoisted(() => vi.fn())
vi.mock('../../db/pg.js', () => ({ pool: { query } }))
vi.mock('../aiMemoryService.js', () => ({ listAiRules: async () => [{ id: 'r1', text: 'Фільтри Mann — у категорію «Фільтри»' }] }))
import { SECRET_PLACEHOLDER, SERVER_ONLY_TABLES, exportServerOnlyData, withoutSecrets } from '../serverDataExport.js'

// 22.11.2026: лист очікування, листування, пороги тривог і правила помічника є лише в хмарі, а хмарна база
// на безкоштовному тарифі сама не копіюється. Головний ПК раз на добу забирає їх у власну базу.
describe('a copy of the data that lives only in the cloud', () => {
  // У дужках: інакше vitest сприйме повернену заглушку як «прибирання» й викличе її без аргументів.
  beforeEach(() => { query.mockReset() })

  it('never carries keys or passwords of outside services', () => {
    const settings = { shop_name: 'Форсаж', owner_telegram_chat_id: 42, ai_api_key_encrypted: 'enc', kashalot_pin: '1234', kashalot_license_key: 'lic',
      vin_decoder_api_key: 'k', owner_alerts: { till_offline_minutes: 15 }, empty_token: '', none_secret: null }
    expect(withoutSecrets(settings)).toEqual({ shop_name: 'Форсаж', owner_telegram_chat_id: 42, ai_api_key_encrypted: SECRET_PLACEHOLDER,
      kashalot_pin: SECRET_PLACEHOLDER, kashalot_license_key: SECRET_PLACEHOLDER, vin_decoder_api_key: SECRET_PLACEHOLDER,
      owner_alerts: { till_offline_minutes: 15 }, empty_token: '', none_secret: null })
    expect(withoutSecrets({ name: 'Viber', credentials: { token: 't', webhook_secret: 's' } })).toEqual({ name: 'Viber', credentials: SECRET_PLACEHOLDER })
    expect(withoutSecrets([{ nested: { bot_token: 'x', title: 'ok' } }])).toEqual([{ nested: { bot_token: SECRET_PLACEHOLDER, title: 'ok' } }])
    // Звичайні слова, схожі на «pin», не зачіпаємо.
    expect(withoutSecrets({ shipping_note: 'a', pinned: true, storage_bin: 'A1' })).toEqual({ shipping_note: 'a', pinned: true, storage_bin: 'A1' })
  })

  it('exports the cloud-only tables of this shop only, and the assistant rules', async () => {
    query.mockImplementation(async (sql: string) => ({ rows: sql.includes('shop_settings') ? [{ tenant_id: 't', shop_name: 'Форсаж', ai_api_key_encrypted: 'enc' }] : [] }))
    const data = await exportServerOnlyData('t', new Date('2026-11-22T17:00:00Z'))
    expect(data).toMatchObject({ version: 1, exported_at: '2026-11-22T17:00:00.000Z', tenant_id: 't', errors: {}, ai_rules: [{ id: 'r1' }] })
    expect(Object.keys(data.tables).sort()).toEqual([...SERVER_ONLY_TABLES, 'messenger_messages'].sort())
    expect(data.tables.shop_settings).toEqual([{ tenant_id: 't', shop_name: 'Форсаж', ai_api_key_encrypted: SECRET_PLACEHOLDER }])
    for (const call of query.mock.calls) {
      expect(call[1][0]).toBe('t')
      expect(String(call[0])).toMatch(/tenant_id = \$1/)
    }
  })

  it('one unreadable table does not stop the rest', async () => {
    query.mockImplementation(async (sql: string) => { if (sql.includes('product_waitlist')) throw new Error('relation does not exist'); return { rows: [{ id: 1 }] } })
    const data = await exportServerOnlyData('t')
    expect(data.errors).toEqual({ product_waitlist: 'relation does not exist' })
    expect(data.tables.product_waitlist).toBeUndefined()
    expect(data.tables.price_list_links).toEqual([{ id: 1 }])
  })

  it('only the main PC with its own key may take it', () => {
    const routes = readFileSync(new URL('../../routes/tillDevice.ts', import.meta.url), 'utf8')
    expect(routes).toContain("tillDeviceRouter.post('/server-data', requireTillDevice")
  })
})
