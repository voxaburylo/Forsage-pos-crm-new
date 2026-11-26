import { describe, expect, it } from 'vitest'
import { sortLineText, type SortState } from './SiteCategorySortPanel'

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
