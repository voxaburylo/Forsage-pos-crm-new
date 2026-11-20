import { describe, expect, it } from 'vitest'
import { isPastedTable } from './aiPasteKind'

describe('pasted text in the assistant', () => {
  it('keeps a multi-line instruction as a message', () => {
    const prompt = 'Розберись із дублями після накладної Покрова від 18.11:\n1. Центральні замки Elegant EL 101 514, EL 101 516 — шукай з пробілами і без.\n2. EL 101 513 «2шт» і EL 101513 «Ціна за 1шт» — не обʼєднуй.\n\nСпершу покажи список.'
    expect(isPastedTable(prompt)).toBe(false)
    expect(isPastedTable('одне питання')).toBe(false)
  })
  it('treats copied tables as an invoice table', () => {
    expect(isPastedTable('№\tНазва\tК-сть\n1\tКлема\t2')).toBe(true)
    expect(isPastedTable('Назва;Артикул;К-сть\nКлема;EL 100 553;2\nЗамок;EL 101 514;1')).toBe(true)
    expect(isPastedTable('| Назва | К-сть | Ціна |\n| Клема | 2 | 49 |')).toBe(true)
  })
  it('treats a priced product list from a messenger as an invoice', () => {
    expect(isPastedTable('1️⃣ Ключ балонний 18″\nКількість: 1 шт.\nЗакупівля: 141 грн/шт.\n\n2️⃣ Ключ 20″\nЗакупівля: 162 грн/шт.')).toBe(true)
  })
  it('always attaches in the explicit invoice mode', () => {
    expect(isPastedTable('Клема 2 шт 49 грн\nЗамок 1 шт 173 грн', true)).toBe(true)
  })
})
