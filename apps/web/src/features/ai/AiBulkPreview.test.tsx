import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BulkPreviewTable } from './AiBulkPreview'
import type { AiPendingAction } from './aiApi'

// 26.11.2026, власник (скрин з телефона): «чому на обʼєднання дублів видало один товар?» — друга колонка була за краєм.
describe('assistant bulk preview on a phone', () => {
  const action = {
    id: 'a1', tool: 'merge_products_bulk', title: "Об'єднати дублі: 1 пар", changes: [], count: 1,
    columns: ['Залишається', 'Зливається (зникне)'],
    items: [{ 'Залишається': '82305 · Запобіжники (плоскі міні 10A) WTB (50 шт)', 'Зливається (зникне)': '111 · Запобіжники міні 10А (0 шт)' }],
  } as unknown as AiPendingAction

  it('every column of a row is shown in the phone card, one under another (letter «s» check: «шт»)', () => {
    const html = renderToStaticMarkup(<BulkPreviewTable action={action} maxRows={5} />)
    const cards = html.slice(html.indexOf('data-ai-bulk-cards'), html.indexOf('</ol>'))
    expect(cards).toContain('Залишається')
    expect(cards).toContain('Зливається (зникне)')
    expect(cards).toContain('82305 · Запобіжники')
    expect(cards).toContain('111 · Запобіжники міні 10А (0 шт)')
    expect(html).toMatch(/<ol class="[^"]*sm:hidden[^"]*" data-ai-bulk-cards/)
    expect(html).toContain('hidden sm:block') // на ПК — таблиця
  })
})
