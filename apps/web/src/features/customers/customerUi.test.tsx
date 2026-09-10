import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CustomerBalances } from './CustomerBalances'
import { customerCashPath, mergeCustomerPage, parseCustomerMoney } from './customerUi'
import type { Customer } from '@/types/customer'

describe('customer balances and list helpers', () => {
  it.each([['1 234,56', 123456], ['0', 0], ['0.01', 1], ['12.50', 1250]])('parses %s in kopecks', (value, result) => {
    expect(parseCustomerMoney(String(value))).toBe(result)
  })
  it.each(['', '-1', 'abc', '1.234', 'Infinity', '1e3'])('rejects invalid amount %s', (value) => expect(parseCustomerMoney(value)).toBeNull())
  it('merges pages without duplicates or moving existing cards', () => {
    expect(mergeCustomerPage([{ id: 'a', name: 'old' }, { id: 'b', name: 'B' }], [{ id: 'a', name: 'new' }, { id: 'c', name: 'C' }])).toEqual([{ id: 'a', name: 'new' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }])
  })
  it('links to customer settlements, not an order or a new cart', () => expect(customerCashPath('a b')).toBe('/pos?customerMoney=a%20b'))
  it('keeps debt, deposit and bonuses separate', () => {
    const html = renderToStaticMarkup(<CustomerBalances customer={{ debt_balance: 10000, bonus_balance: 2000, deposit_balance: 3000 } as Customer}/>)
    expect(html).toContain('Клієнт винен магазину')
    expect(html).toContain('Кошти клієнта')
    expect(html).toContain('Бонуси')
    expect(html).toContain('не взаємозаліковуються')
    expect(html).not.toContain('Не завантажено')
  })
  it('does not present an unknown deposit as zero', () => {
    expect(renderToStaticMarkup(<CustomerBalances customer={{ debt_balance: 0, bonus_balance: 0 } as Customer}/>)).toContain('Не завантажено')
  })
})
