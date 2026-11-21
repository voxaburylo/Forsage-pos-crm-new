import { expect, it } from 'vitest'
import { stockWarningText } from './stockWarning'

it('says the sale goes negative and lands in the recount list', () => {
  expect(stockWarningText('Фільтр', 0, 'шт')).toBe('«Фільтр»: за програмою немає. Продаж у мінус — товар потрапить у «Перерахунок».')
  expect(stockWarningText('Фільтр', 2, 'шт')).toBe('«Фільтр»: за програмою 2 шт. Продаж у мінус — товар потрапить у «Перерахунок».')
})
