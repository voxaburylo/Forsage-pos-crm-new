import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { chosenMerges, declinedPairs, MergeProposal, mergeRows } from './AiMergeProposal'
import type { AiPendingAction } from './aiApi'

// 26.11.2026, власник: «у чому не впевнений — таблицею; у чому впевнений на 100% — таблиця не потрібна, тільки підтвердити».
const action = {
  id: 'm1', tool: 'merge_products_bulk', title: "Об'єднати дублі: 3 пар", changes: [], count: 3,
  columns: ['Залишається', 'Зливається (зникне)', 'Чому'],
  items: [
    { 'Залишається': '82305 · Запобіжники міні 10A WTB (50 шт)', 'Зливається (зникне)': '81072 · Запобіжники міні 10A WTB (0 шт)', 'Чому': 'та сама назва й упаковка' },
    { 'Залишається': '82305 · Запобіжники міні 10A WTB (50 шт)', 'Зливається (зникне)': '111 · Запобіжники ...М-10А (0 шт)', 'Чому': 'назва обрізана — перевірте упаковку' },
    { 'Залишається': 'A1 · Клеми АКБ (4 шт)', 'Зливається (зникне)': 'A2 · Клеми акумулятора (1 шт)', 'Чому': 'різна назва' },
  ],
  payload: { merges: [
    { primary_product_id: 'p1', duplicate_product_id: 'd1', reason: 'та сама назва й упаковка', sure: true },
    { primary_product_id: 'p1', duplicate_product_id: 'd2', reason: 'назва обрізана — перевірте упаковку', sure: false },
    { primary_product_id: 'p3', duplicate_product_id: 'd3', reason: 'різна назва' },
  ] },
} as unknown as AiPendingAction

describe('duplicate merge proposal: sure pairs by one button, doubtful ones in a table', () => {
  it('splits by the assistant mark; a pair without a mark counts as doubtful', () => {
    const rows = mergeRows(action)
    expect(rows.sure.map(row => row.pair.duplicate_product_id)).toEqual(['d1'])
    expect(rows.doubt.map(row => row.pair.duplicate_product_id)).toEqual(['d2', 'd3'])
  })

  it('confirm merges the sure pairs plus only the doubtful ones the owner ticked', () => {
    const rows = mergeRows(action)
    expect(chosenMerges(rows, new Set()).map(pair => pair.duplicate_product_id)).toEqual(['d1'])
    expect(chosenMerges(rows, new Set([2])).map(pair => pair.duplicate_product_id)).toEqual(['d1', 'd3'])
  })

  // 26.11.2026, власник: «пошук знаходить повторно дублі, які ми вже виправили».
  it('unticked doubtful pairs are remembered as «not duplicates»; ticked and sure ones are not', () => {
    const rows = mergeRows(action)
    expect(declinedPairs(rows, new Set())).toEqual([{ a: 'p1', b: 'd2' }, { a: 'p3', b: 'd3' }])
    expect(declinedPairs(rows, new Set([2]))).toEqual([{ a: 'p1', b: 'd2' }])
    const html = renderToStaticMarkup(<MergeProposal action={action} busy={false} onConfirm={() => undefined} onReject={() => undefined} />)
    expect(html).toContain('Невідмічені програма запамʼятає як «не дублі»')
  })

  it('sure pairs are one line (no table); doubtful ones show both cards and the reason, unticked (letter «s» check: «шт»)', () => {
    const html = renderToStaticMarkup(<MergeProposal action={action} busy={false} onConfirm={() => undefined} onReject={() => undefined} />)
    expect(html).toContain('Точно той самий товар: 1 пара')
    expect(html).toContain('Сумнівні: 2')
    expect(html).toContain('111 · Запобіжники ...М-10А (0 шт)')
    expect(html).toContain('назва обрізана — перевірте упаковку')
    expect(html).not.toMatch(/data-ai-merge-pick="1"[^>]*checked/)
    expect(html.replace(/<!-- -->/g, '')).toContain('Підтвердити (1)')
  })
})
