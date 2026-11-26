import { describe, expect, it, vi } from 'vitest'
import { AUTO_MERGE_MAX_CARDS, AUTO_MERGE_REASON, applyAutoMerges, autoMergePlan, autoMergeTarget, autoMergeVerdict, factoryBarcode, literalName } from './catalogAutoMerge'
import type { CleanupGroup, CleanupPreview, CleanupProduct, CleanupScan } from './catalogCleanupModel'

// 26.11.2026, слово власника: «дублі зі стовідсотковою схожістю обʼєднувати автоматично».
// Картки й назви — справжні з копії бази (26.11.2026).
const card = (id: string, name: string, over: Partial<CleanupProduct> = {}): CleanupProduct =>
  ({ id, name, sku: id, unit: 'шт', qty_on_hand: 0, purchase_price: 1000, retail_price: 3000, barcode: null, fingerprint: 'f-' + id, ...over })

describe('which duplicates the program may merge without a person looking at each pair', () => {
  it('a factory barcode is 8–14 digits and not the shop range starting with 2', () => {
    expect([factoryBarcode('4008321100955'), factoryBarcode('8711500482730'), factoryBarcode('0199442260')]).toEqual([true, true, true])
    expect([factoryBarcode('2000998832391'), factoryBarcode('20976378'), factoryBarcode(''), factoryBarcode(null), factoryBarcode('WA6684')]).toEqual([false, false, false, false, false])
  })

  it('the name must match letter for letter; only letter case and extra spaces are forgiven', () => {
    expect(literalName('Фільтр  масляний  CHAMPION class S ')).toBe(literalName('фільтр масляний champion CLASS s'))
    expect(literalName('Фільтр class S')).not.toBe(literalName('Фільтр cla'))
    // Справжні пари: пошук дублів каси вважає їх «точними» (номер моделі, синоніми), але це, найімовірніше, різні товари.
    expect(autoMergeVerdict([card('a', 'Ліхтар BL-511 Police', { retail_price: 13500 }), card('b', 'Ліхтарик BL-511', { retail_price: 29000 })])).toEqual({ ok: false, reason: 'Назви не збігаються буква в букву' })
    expect(autoMergeVerdict([card('a', 'Клеми акумулятора'), card('b', 'Клеми АКБ')])).toEqual({ ok: false, reason: 'Назви не збігаються буква в букву' })
    expect(autoMergeVerdict([card('a', 'Автолампа W16W 12V 16W W2.1X9.5D OSRAM', { barcode: '4008321100955' }), card('b', 'PHILIPS W16W 12V 16W W2.1X9.5D / STANDARD', { barcode: '8711500482730' })])).toMatchObject({ ok: false })
  })

  it('same name, shop barcodes only: merged; the higher prices win and the stock is summed', () => {
    const a = card('81076', 'Запобіжники (плоскі євро 10А) MTA GE-10', { barcode: '2000998700001', qty_on_hand: 5, retail_price: 350, purchase_price: 130, created_at: '2026-05-22T10:00:00Z' })
    const b = card('88903', 'Запобіжники (плоскі євро 10А) MTA GE-10', { barcode: '2000998700002', qty_on_hand: 2, retail_price: 400, purchase_price: 150, created_at: '2026-09-01T10:00:00Z' })
    expect(autoMergeVerdict([a, b])).toEqual({ ok: true, target_id: '81076', source_ids: ['88903'], retail_price: 400, purchase_price: 150, raise: true, quantity: 7 })
    expect(autoMergeVerdict([a, { ...b, retail_price: 350, purchase_price: 130 }])).toMatchObject({ ok: true, raise: false })
  })

  it('the main card is the one that is easier to use: factory barcode, real article, more stock, older', () => {
    const name = 'Щуп веерный 17 лепестков 0,02-1,0мм YATO'
    const factory = card('88848', name, { barcode: '5906083972201' }), shop = card('88429', name, { barcode: '2000998830274', qty_on_hand: 9 })
    expect(autoMergeTarget([shop, factory]).id).toBe('88848')
    const auto = card('x', name, { sku: 'AUTO-7FA67C8B44544093BA1187D442F7105D', qty_on_hand: 9 }), real = card('y', name, { sku: 'bn-04412' })
    expect(autoMergeTarget([auto, real]).id).toBe('y')
    expect(autoMergeTarget([card('p', name, { qty_on_hand: 1 }), card('q', name, { qty_on_hand: 4 })]).id).toBe('q')
    expect(autoMergeTarget([card('new', name, { created_at: '2026-11-01T00:00:00Z' }), card('old', name, { created_at: '2026-05-01T00:00:00Z' })]).id).toBe('old')
  })

  it('refuses everything that is not 100%', () => {
    const a = card('a', 'Ремінь поліклиновий BOSCH 1987946251'), b = card('b', 'Ремінь поліклиновий BOSCH 1987946251')
    // Кабель Baseus (справжня пара): та сама назва, але два різні заводські коди.
    const cable = (id: string, barcode: string) => card(id, 'Кабель Baseus Type-C Glimmer Series Fast Charging Data Cable', { barcode })
    expect(autoMergeVerdict([cable('c1', '0199442260'), cable('c2', '6932172617967')])).toEqual({ ok: false, reason: 'Різні заводські штрихкоди — це можуть бути різні товари' })
    // Той самий заводський код основним і додатковим — один товар.
    expect(autoMergeVerdict([cable('c1', '6932172617967'), { ...cable('c2', '2000998700009'), additional_barcodes: ['6932172617967'] }])).toMatchObject({ ok: true })
    expect(autoMergeVerdict([{ ...a, retail_price: 13500 }, { ...b, retail_price: 29000 }])).toMatchObject({ ok: false, reason: expect.stringContaining('більш ніж на 30%') })
    expect(autoMergeVerdict([{ ...a, purchase_price: 1000 }, { ...b, purchase_price: 1301 }])).toMatchObject({ ok: false, reason: expect.stringContaining('більш ніж на 30%') })
    // Ціна 0 (не задана) в однієї з карток різницею не вважається.
    expect(autoMergeVerdict([{ ...a, retail_price: 0 }, b])).toMatchObject({ ok: true, retail_price: 3000, raise: true })
    const many = Array.from({ length: AUTO_MERGE_MAX_CARDS + 1 }, (_, index) => card('m' + index, 'Однакова назва'))
    expect(autoMergeVerdict(many)).toMatchObject({ ok: false, reason: expect.stringContaining('перегляньте вручну') })
    expect(autoMergeVerdict([a, { ...b, qty_on_hand: -1 }])).toMatchObject({ ok: false, reason: expect.stringContaining('Відʼємний') })
    expect(autoMergeVerdict([{ ...a, retail_price: 390, purchase_price: 300000 }, { ...b, retail_price: 390, purchase_price: 300000 }])).toMatchObject({ ok: false, reason: expect.stringContaining('нижчою за закупку') })
    expect(autoMergeVerdict([a, { ...b, unit: 'компл' }])).toEqual({ ok: false, reason: 'Різні одиниці обліку' })
    expect(autoMergeVerdict([{ ...a, brand_id: 'bosch' }, { ...b, brand_id: 'gates' }])).toEqual({ ok: false, reason: 'Різні бренди в картках' })
    expect(autoMergeVerdict([a])).toMatchObject({ ok: false })
  })

  it('the plan is built from identical names (not from the till «exact» list) and respects conflicts the till found', () => {
    const group = (ids: string[], level: CleanupGroup['level']): CleanupGroup => ({ id: 'g-' + ids.join(), level, product_ids: ids, reasons: [], conflicts: [] })
    const scan = { sku_suggestions: [], products: [
      card('a', 'Запобіжники MTA GE-10', { qty_on_hand: 1 }), card('b', 'запобіжники  mta ge-10', { qty_on_hand: 4 }),
      card('c', 'Сальник лівий/правий'), card('d', 'Сальник лівий/правий'),
      card('e', 'Лампа', { barcode: '4008321100955' }), card('f', 'Лампа', { barcode: '8711500482730' }),
      card('g', 'Одна така'), card('h', ''), card('i', ''),
    ], groups: [group(['a', 'b'], 'review'), group(['c', 'd'], 'conflict')] } as unknown as CleanupScan
    const plan = autoMergePlan(scan)
    expect(plan.same_name_groups).toBe(3)
    expect(plan.rows.map(row => [row.name, row.cards.length, row.verdict.target_id, row.verdict.quantity])).toEqual([['Запобіжники MTA GE-10', 2, 'b', 5]])
    expect(plan.skipped).toEqual([
      { name: 'Сальник лівий/правий', reason: 'Пошук дублів бачить між картками суперечність — перегляньте вручну' },
      { name: 'Лампа', reason: 'Різні заводські штрихкоди — це можуть бути різні товари' },
    ])
  })
})

describe('merging the plan goes through the till checks, one group at a time', () => {
  const preview = (over: Partial<CleanupPreview> = {}): CleanupPreview => ({ fingerprint: 'a'.repeat(64), target_id: 't', source_ids: ['s'], products: [], history_counts: {}, blockers: [], warnings: [],
    quantity_before: [5, 2], quantity_after: 7, barcodes: [], photos: [], can_apply: true, stock_review: 'pending', ...over })
  const row = (name: string, raise = false) => ({ name, cards: [card('t', name), card('s', name)],
    verdict: { ok: true as const, target_id: 't', source_ids: ['s'], retail_price: 400, purchase_price: 150, raise, quantity: 7 } })

  it('raises the price only after the till agreed, then asks the till again and writes with the fresh check', async () => {
    const calls: string[] = []
    const bridge = { cleanupPreview: vi.fn(async () => { calls.push('preview'); return preview({ warnings: ['Ціни відрізняються; залишаться ціни головної картки: X', 'Фактичну наявність не перевірено. …', 'Потрібне підтвердження тотожності: Різні артикули в полях можуть бути внутрішніми кодами'] }) }),
      cleanupApply: vi.fn(async () => { calls.push('apply'); return { quantity_after: 7, backupPath: 'C:/backup.db' } }) }
    const raisePrices = vi.fn(async () => { calls.push('raise') })
    const progress = vi.fn()
    const result = await applyAutoMerges([row('Запобіжники', true)], { bridge, raisePrices, operationId: () => '11111111-1111-4111-8111-111111111111', onProgress: progress })
    expect(calls).toEqual(['preview', 'raise', 'preview', 'apply'])
    expect(raisePrices).toHaveBeenCalledWith('t', { retail_price: 400, purchase_price: 150 })
    expect(bridge.cleanupApply).toHaveBeenCalledWith({ target_id: 't', source_ids: ['s'], stock_review: 'pending', preview_fingerprint: 'a'.repeat(64), reason: AUTO_MERGE_REASON, operation_id: '11111111-1111-4111-8111-111111111111' })
    expect(result).toEqual({ merged: 1, cards: 1, skipped: [], backupPath: 'C:/backup.db', stopped: false })
    expect(progress).toHaveBeenCalledWith(1, 1)
  })

  it('a group the till refuses, or one with any other warning, is skipped with the reason — its price is not touched; the rest go on', async () => {
    const answers = [preview({ can_apply: false, blockers: ['Є відкрита накладна'] }), preview({ warnings: ['Історичні зв’язки прайсів залишаться на початкових картках; прайси не переписуються.'] }), preview()]
    const bridge = { cleanupPreview: vi.fn(async () => answers.shift()!), cleanupApply: vi.fn(async () => ({ quantity_after: 7 })) }
    const raisePrices = vi.fn(async () => undefined)
    const result = await applyAutoMerges([row('Перша', true), row('Друга', true), row('Третя')], { bridge, raisePrices, operationId: () => '22222222-2222-4222-8222-222222222222' })
    expect(raisePrices).not.toHaveBeenCalled()
    expect(bridge.cleanupApply).toHaveBeenCalledTimes(1)
    expect(result.merged).toBe(1)
    expect(result.skipped).toEqual([{ name: 'Перша', reason: 'Є відкрита накладна' }, { name: 'Друга', reason: 'Історичні зв’язки прайсів залишаться на початкових картках; прайси не переписуються.' }])
  })

  it('a failure of one group does not stop the others; «stop» ends the run between groups', async () => {
    const bridge = { cleanupPreview: vi.fn(async () => preview()), cleanupApply: vi.fn().mockRejectedValueOnce(new Error('Дані змінилися після перевірки')).mockResolvedValue({ quantity_after: 7 }) }
    let stop = false
    const result = await applyAutoMerges([row('A'), row('B'), row('C')], { bridge, raisePrices: async () => undefined, operationId: () => '33333333-3333-4333-8333-333333333333',
      shouldStop: () => stop, onProgress: done => { if (done === 2) stop = true } })
    expect(result).toMatchObject({ merged: 1, stopped: true, skipped: [{ name: 'A', reason: 'Дані змінилися після перевірки' }] })
    expect(bridge.cleanupApply).toHaveBeenCalledTimes(2)
  })
})
