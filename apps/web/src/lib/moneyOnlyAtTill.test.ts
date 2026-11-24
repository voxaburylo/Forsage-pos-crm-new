import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MONEY_ONLY_AT_TILL, moneyOnlyAtTill } from './moneyOnlyAtTill'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return sources(full)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}

// 24.11.2026 (план T9): гроші в касі — лише на касі. Записів грошей прямо на сервер у вебі більше немає.
describe('no money writes from the web to the server', () => {
  it('refuses with one clear message', () => {
    expect(() => moneyOnlyAtTill()).toThrow(MONEY_ONLY_AT_TILL)
    try { moneyOnlyAtTill() } catch (error) { expect(error).toMatchObject({ code: 'WEB_IS_READ_ONLY', status: 403 }) }
  })

  it('no web code sends a sale, return, shift, cash operation, payment, deposit, debt or salary to the server', () => {
    const money = /api\.(post|put|patch|delete)\s*(<[^(]*>)?\s*\(\s*[`'"]\/api\/v1\/(sales(?!\/calculate-price)(\/|[`'"])|returns[`'"]|shifts\/|cash-operations[`'"]|salary|customers\/\$\{[^}]+\}\/(pay-debt|deposit)|customer-orders\/\$\{[^}]+\}\/(payments|complete))/
    const offenders = sources(SRC).filter(file => money.test(readFileSync(file, 'utf8'))).map(file => path.relative(SRC, file))
    expect(offenders).toEqual([])
  })
})
