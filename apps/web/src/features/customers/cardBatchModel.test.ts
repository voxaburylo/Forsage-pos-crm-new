import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CARD_BATCH_MAX, CARD_FORMATS, FREE_CARD_EVENT, cardBatchFileName, cardCodeFromParam, cardCodesSheet, cardCodesText, cardFormatLabel,
  newCustomerWithCardPath, parseCardCount,
} from './cardBatchModel'

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

// 23.11.2026 (план B2): пачки штрихкодів для карток клієнтів — для друкарні.
describe('customer card batches: the screen', () => {
  it('the amount is a whole number within the limit, with a plain explanation otherwise', () => {
    expect(parseCardCount('100')).toEqual({ count: 100 })
    expect(parseCardCount(' 1 000 ')).toEqual({ count: 1000 })
    expect(parseCardCount(String(CARD_BATCH_MAX))).toEqual({ count: CARD_BATCH_MAX })
    for (const bad of ['', 'abc', '1.5', '-3', '1e3', '12345678']) expect(parseCardCount(bad)).toHaveProperty('error')
    expect(parseCardCount('0')).toEqual({ error: 'Потрібна хоча б одна картка' })
    expect(parseCardCount(String(CARD_BATCH_MAX + 1))).toHaveProperty('error')
  })

  it('the format is chosen at generation: 13 digits by default, 10 digits as the old cards', () => {
    expect(CARD_FORMATS.map(item => item.id)).toEqual(['ean13', 'digits10'])
    expect(cardFormatLabel('ean13')).toContain('13 цифр')
    expect(cardFormatLabel('digits10')).toContain('10 цифр')
    expect(read('./CustomerCardsPage.tsx')).toContain("useState<CardFormat>('ean13')")
  })

  it('the column for the printing house: one code per line, nothing else', () => {
    expect(cardCodesText(['2900000000017', '2900000000024'])).toBe('2900000000017\n2900000000024')
    expect(cardCodesText([])).toBe('')
  })

  it('Excel keeps codes as text, so 13 digits never turn into 2,9E+12', () => {
    expect(cardCodesSheet(['2900000000017'])).toEqual([[{ t: 's', v: '2900000000017', z: '@' }]])
    expect(cardBatchFileName('2026-11-23T12:00:00.000Z', 1000)).toBe('Картки-клієнтів-2026-11-23-1000шт.xlsx')
    expect(cardBatchFileName('', 5)).toBe('Картки-клієнтів-пачка-5шт.xlsx')
  })

  it('a card code from the address is digits only', () => {
    expect(cardCodeFromParam('2900000000017')).toBe('2900000000017')
    expect(cardCodeFromParam(' 77000 00001 ')).toBe('7700000001')
    for (const bad of [null, undefined, '', '123', 'abc', "1' OR 1=1", '1'.repeat(15)]) expect(cardCodeFromParam(bad)).toBe('')
    expect(newCustomerWithCardPath('7700000001')).toBe('/customers/new?card=7700000001')
  })

  it('the till offers to bind a free card on the first scan; the card field of a new customer is prefilled', () => {
    const till = read('../pos/SearchPanel.tsx')
    const notFound = till.indexOf("'Штрих-код не знайдено в локальній базі'")
    const free = till.indexOf('isFreeCard?.(normalizedCode)')
    // Спершу товар і картка клієнта, і лише коли код нікому не належить — «вільна картка»; потім «не знайдено».
    expect(free).toBeGreaterThan(till.indexOf('localCustomerLookup(normalizedCode)'))
    expect(free).toBeLessThan(notFound)
    expect(till).toContain('new CustomEvent(FREE_CARD_EVENT, { detail: { code: normalizedCode } })')
    expect(FREE_CARD_EVENT).toBe('forsage:free-card-scanned')
    expect(read('../pos/POSPage.tsx')).toContain('<FreeCardModal />')
    const modal = read('../pos/FreeCardModal.tsx')
    // Чужу картку не затираємо мовчки, і системного вікна підтвердження немає (в Electron воно ламає фокус).
    expect(modal).toContain('if (current.card_barcode && current.card_barcode !== code && !replace)')
    expect(modal).not.toContain('window.confirm')
    expect(modal).toContain('expected_updated_at: current.updated_at')
    expect(read('./CustomerFormPage.tsx')).toContain('{ ...EMPTY, card_barcode: cardFromLink }')
  })

  it('only the owner and the administrator issue batches; the section works through the main PC', () => {
    const app = read('../../App.tsx')
    expect(app.match(/<Route path="\/customers\/cards"[^\n]+/)?.[0]).toContain('<TillOnly what="Картки для друку"><ProtectedRoute roles={ADMIN_ROLES}>')
    const rules = read('../../../../desktop/src/security/desktopAuthorization.ts')
    for (const channel of ['desktop:pos:card-batches', 'desktop:pos:card-batch-codes', 'desktop:pos:card-batch-create']) expect(rules).toContain(`['${channel}', OWNER_ROLES]`)
  })
})
