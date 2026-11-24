import { describe, expect, it, vi } from 'vitest'
import { applyChatCatalogUpdates, ensureChatCategories, planChatCatalogUpdates, renameChatCategories } from './aiCatalogApply'

const fp = (id: string, name: string, category_id: string | null = 'oil') => ({ product_id: id, fingerprint: 'f-' + id, name, category_id })
const categories = [{ id: 'oil', name: 'Масла-ATF' }, { id: 'chem', name: 'Химия' }]

describe('assistant chat catalog updates on the till', () => {
  it('sends only real name/category changes with the card fingerprint', () => {
    const plan = planChatCatalogUpdates([
      { product_id: 'a', new_name: 'Моторна олива Polo Expert 10W40 API SL/CF 1л, метал (12)', category_name: 'масла-atf' },
      { product_id: 'b', new_name: '(метал) 10W40 ASM 4л (4)' },
      { product_id: 'c', category_name: 'Химия' },
    ], [fp('a', '(метал) 10W40 API SL/CF 1л (12)'), fp('b', '(метал) 10W40 ASM 4л (4)'), fp('c', 'Очисник')], categories)
    expect(plan.items).toEqual([
      { product_id: 'a', fingerprint: 'f-a', changes: { name: 'Моторна олива Polo Expert 10W40 API SL/CF 1л, метал (12)' } },
      { product_id: 'c', fingerprint: 'f-c', changes: { category_id: 'chem' } },
    ])
    expect(plan.unchanged).toBe(1)
  })

  it('skips unknown categories, missing cards and repeats with a reason instead of guessing', () => {
    const plan = planChatCatalogUpdates([
      { product_id: 'a', category_name: 'Нова папка' },
      { product_id: 'gone', new_name: 'X' },
      { product_id: 'c', new_name: 'Y' },
      { product_id: 'c', new_name: 'Z' },
    ], [fp('a', 'A'), { product_id: 'gone', fingerprint: null }, fp('c', 'C')], categories)
    expect(plan.items.map(item => item.product_id)).toEqual(['c'])
    expect(plan.skipped.map(row => row.error)).toEqual([
      expect.stringContaining('Категорію «Нова папка» не знайдено'),
      'Товар не знайдено в базі каси',
      'Повторний товар у пропозиції',
    ])
  })

  it('creates a missing category once and then files the products into it', async () => {
    const createCategory = vi.fn(async (name: string) => ({ id: 'new-' + name, name }))
    const bridge = {
      agentFingerprints: vi.fn(async (ids: string[]) => ids.map(id => fp(id, 'Стара ' + id, null))),
      agentApply: vi.fn(async (input: any) => ({ updated: input.items.length, backupPath: 'b.db' })),
    }
    const result = await applyChatCatalogUpdates([
      { product_id: 'a', category_name: 'Автозвук' }, { product_id: 'b', category_name: ' автозвук ' }, { product_id: 'c', category_name: 'Химия' },
    ], bridge, categories, async () => 'op', createCategory)
    expect(createCategory).toHaveBeenCalledTimes(1)
    expect(result.createdCategories).toEqual(['Автозвук'])
    expect(bridge.agentApply.mock.calls[0][0].items.map((item: any) => item.changes.category_id)).toEqual(['new-Автозвук', 'new-Автозвук', 'chem'])
  })

  it('renames categories to Ukrainian but never onto another category name', async () => {
    const updateCategory = vi.fn(async () => ({}))
    const result = await renameChatCategories([
      { category_id: 'oil', new_name: 'Оливи-ATF' }, { category_id: 'chem', new_name: 'Оливи-ATF' }, { category_id: 'gone', new_name: 'X' },
    ], categories, updateCategory)
    expect(updateCategory).toHaveBeenCalledWith('oil', 'Оливи-ATF')
    expect(result.renamed).toBe(1)
    expect(result.skipped.map(row => row.error)).toEqual([expect.stringContaining('дубль'), 'Категорію не знайдено'])
    const created = await ensureChatCategories(['Масла-ATF', 'Нова'], categories, async name => ({ id: 'n', name }))
    expect(created.created).toEqual(['Нова'])
  })

  it('writes in parts of 500 (one backup each) with skip_invalid and reports what the till refused', async () => {
    const updates = Array.from({ length: 650 }, (_, i) => ({ product_id: 'p' + i, new_name: 'Нова ' + i }))
    const bridge = {
      agentFingerprints: vi.fn(async (ids: string[]) => ids.map(id => fp(id, 'Стара ' + id))),
      agentApply: vi.fn(async (input: any) => ({
        updated: input.items.length - 1,
        skipped: [{ product_id: input.items[0].product_id, name: 'Стара', error: 'Переклад змінює технічні номери або розміри' }],
        backupPath: 'b.db',
      })),
    }
    const result = await applyChatCatalogUpdates(updates, bridge, categories, async chunk => 'op-' + chunk)
    expect(bridge.agentApply).toHaveBeenCalledTimes(2)
    expect(bridge.agentApply.mock.calls[0][0]).toMatchObject({ skip_invalid: true, operation_id: 'op-0' })
    expect(bridge.agentApply.mock.calls[0][0].items).toHaveLength(500)
    expect(result).toMatchObject({ updated: 648, unchanged: 0, backupPath: 'b.db' })
    expect(result.skipped).toHaveLength(2)
  })

  // 24.11.2026: наведення порядку в назвах — артикул із назви й позначка cleanup доходять до каси.
  it('passes the article taken from the name and the cleanup mark to the till, and never resends the same article', () => {
    const plan = planChatCatalogUpdates([
      { product_id: 'a', new_name: 'Фільтр повітряний KAVO FAF-10740', new_sku: 'FAF-10740', cleanup: true },
      { product_id: 'b', new_name: 'Фільтр W67/1', new_sku: 'W67/1' },
      { product_id: 'c', new_sku: 'X-1', cleanup: true },
    ], [{ ...fp('a', 'KAVO KV FAF-10740 372 87 Фільтр повітряний'), sku: 'AUTO-1' }, { ...fp('b', 'Фильтр W67/1'), sku: 'W67/1' }, { ...fp('c', 'Товар X-1'), sku: 'AUTO-3' }], categories)
    expect(plan.items).toEqual([
      { product_id: 'a', fingerprint: 'f-a', changes: { name: 'Фільтр повітряний KAVO FAF-10740', sku: 'FAF-10740' }, cleanup: true },
      { product_id: 'b', fingerprint: 'f-b', changes: { name: 'Фільтр W67/1' } },
      { product_id: 'c', fingerprint: 'f-c', changes: { sku: 'X-1' } },
    ])
  })
})
