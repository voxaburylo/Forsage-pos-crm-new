import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AiActionButtons, aiActionKind, aiPrimaryLabel } from './AiActionButtons'

// 26.11.2026, власник: «без купи зайвих нагромаджень, підтверджень і незрозумілих кнопок».
describe('assistant proposal: one confirm button instead of a banner and two steps', () => {
  it('a bulk proposal is confirmed right in the chat; the full list is an optional link', () => {
    const html = renderToStaticMarkup(<AiActionButtons kind="bulk" count={47} loading={false} disabled={false} onPrimary={() => undefined} onViewAll={() => undefined} onReject={() => undefined} />)
    expect(html.replace(/<!-- -->/g, '')).toContain('Підтвердити (47)')
    expect(html).toContain('усі рядки')
    expect(html).toContain('Відхилити')
    expect(html).not.toContain('Ще не збережено')
    expect(html).not.toContain('Переглянути та підтвердити')
  })

  it('an order from the notebook and an invoice still open their own check screen', () => {
    expect(aiActionKind({ isOrder: true, isInvoice: false, isBulk: false })).toBe('order')
    expect(aiActionKind({ isOrder: false, isInvoice: true, isBulk: true })).toBe('invoice')
    expect(aiActionKind({ isOrder: false, isInvoice: false, isBulk: false })).toBe('single')
    expect(aiPrimaryLabel('order')).toBe('Перевірити та створити замовлення')
    expect(aiPrimaryLabel('invoice', 12)).toBe('Відкрити накладну (12)')
    expect(aiPrimaryLabel('single')).toBe('Підтвердити')
    const html = renderToStaticMarkup(<AiActionButtons kind="invoice" count={3} loading={false} disabled={false} onPrimary={() => undefined} onReject={() => undefined} />)
    expect(html).not.toContain('усі рядки')
  })
})
