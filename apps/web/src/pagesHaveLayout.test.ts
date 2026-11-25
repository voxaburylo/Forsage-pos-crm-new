import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// 25.11.2026 (власник: «когда заходишь в это окно — выйти с него нельзя никак»): «Видати зарплату» відкривалась
// без загальної рамки (без меню й «Назад»). Кожна сторінка з меню має бути в Layout (або сама малювати меню).
const WITHOUT_MENU = new Set(['pages/LoginPage', 'features/priceLinks/PublicPriceListPage', 'features/staff/StaffSecretsOffline'])

describe('every routed page has the app frame with the menu', () => {
  it('uses Layout', () => {
    const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    const pages = [...app.matchAll(/lazyPage\(\(\) => import\('@\/([^']+)'\)/g)].map(match => match[1])
    expect(pages.length).toBeGreaterThan(20)
    const missing = pages.filter(page => !WITHOUT_MENU.has(page)).filter(page => {
      const file = [`./${page}.tsx`, `./${page}/index.tsx`].map(candidate => new URL(candidate, import.meta.url)).find(url => existsSync(url))
      if (!file) return false
      const source = readFileSync(file, 'utf8')
      return !source.includes('<Layout') && !source.includes('<Sidebar') // «Замовлення» малюють меню самі
    })
    expect(missing).toEqual([])
  })
})
