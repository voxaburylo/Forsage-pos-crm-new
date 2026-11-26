import { describe, expect, it } from 'vitest'
import { newCategoriesText, sortHeadline, sortLineText, sortTiles, type SortState } from './SiteCategorySortPanel'

// 26.11.2026, власник: «товари, що прийшли по API й ще прийдуть, не розсортовані».
const state = (over: Partial<SortState>): SortState => ({ enabled: false, waiting: 62937, sorted: 0, unsure: 0, with_category: 48948, total: 111885, cost_usd: 0, last_error: null, ...over })

describe('category sort for supplier products: one line that says what is going on', () => {
  it('before the start it says how many products have no category and why that matters', () => {
    expect(sortLineText(state({}))).toMatch(/^Без категорії 62.937 із 111.885 товарів постачальників — на сайті вони не потрапляють у жоден розділ каталогу\.$/)
  })
  it('while working: how many are left and what was done; the screen can be closed', () => {
    const line = sortLineText(state({ enabled: true, waiting: 20000, sorted: 40000, unsure: 2937 }))
    expect(line).toMatch(/^Розкладаю: лишилось 20.000 із 111.885/)
    expect(line).toMatch(/помічник розклав 40.000 · не певен щодо 2.937 — вони лишились без категорії/)
    expect(line).toMatch(/Екран можна закрити\.$/)
  })
  it('when done it says that new arrivals will be sorted by themselves', () => {
    expect(sortLineText(state({ enabled: true, waiting: 0, sorted: 58000, unsure: 4937 }))).toMatch(/^Усе розкладено: помічник розклав 58.000.*Нові товари, що прийдуть по API, розкладатимуться самі\.$/)
    expect(sortLineText(state({ waiting: 0, sorted: 5 }))).toMatch(/мають категорію або розглянуті: помічник розклав 5\.$/)
  })
})

// 27.11.2026, власник: «якщо в нас такої категорії немає, то він її створює».
describe('new categories are created by the main PC and said in plain words', () => {
  it('names what is being created and how many products wait; says when the main PC has not answered', () => {
    const text = newCategoriesText(state({ enabled: true, waiting: 0, waiting_new: 1840, waiting_names: ['Кузовні деталі', 'Системи кондиціонування'] }))
    expect(text).toMatch(/створюю нові: «Кузовні деталі», «Системи кондиціонування»\. Їх створює головний ПК; щойно він у мережі, 1.840 товарів ляжуть у них самі\.$/)
    expect(newCategoriesText(state({ waiting_names: ['Кузовні деталі'], waiting_new: 5, till_error: 'Невідома команда. Оновіть програму на касі.' }))).toMatch(/Головний ПК поки відповів: Невідома команда/)
    expect(newCategoriesText(state({}))).toBe('')
  })
})

// 27.11.2026 (огляд знімків): одне довге речення з чотирма числами читалось важко — числа пішли в плитки.
describe('numbers in tiles, one short sentence above them', () => {
  it('shows only the tiles that have something to say; «waiting» is always there', () => {
    expect(sortTiles(state({}))).toEqual([{ label: 'чекають розкладки', value: 62937 }])
    expect(sortTiles(state({ enabled: true, waiting: 20140, sorted: 39850, unsure: 2947, waiting_new: 1840 })).map(tile => tile.value)).toEqual([20140, 39850, 2947, 1840])
    expect(sortTiles(state({ waiting: 0, sorted: 5 }))).toEqual([{ label: 'чекають розкладки', value: 0 }, { label: 'розклав помічник', value: 5 }])
  })
  it('the headline says what is going on without numbers', () => {
    expect(sortHeadline(state({ enabled: true }))).toBe('Розкладаю. Екран можна закрити.')
    expect(sortHeadline(state({ enabled: true, waiting: 0 }))).toMatch(/розкладатимуться самі/)
    expect(sortHeadline(state({}))).toMatch(/не потрапляють у жоден розділ/)
  })
})
