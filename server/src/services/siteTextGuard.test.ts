import { describe, expect, it } from 'vitest'
import { guardProductText, latinWordsIn, measuresIn, numbersIn, parseTextReply, productLine, textJobPrompt, type ProductFacts, type TextFields } from './siteTextGuard.js'

// 26.11.2026, власник: «великі пачки, без купи підтверджень, тільки щоб він не робив дурниць».
// На сайт без людини йде лише текст, у якому немає нічого, чого не було в даних товару.
const oil: ProductFacts = { name: 'Олива моторна Castrol Magnatec 5W-40 A3/B4 4л', sku: '15C9D0', brand: 'Castrol', category: 'Моторні оливи', unit: 'шт', specs: { 'Вʼязкість': '5W-40', 'Обʼєм': '4 л' }, crosses: ['156E9E'] }
const good: TextFields = {
  description: 'Синтетична моторна олива Castrol Magnatec 5W-40 A3/B4 у каністрі 4 л. Підходить для двигунів, де виробник авто вимагає вʼязкість 5W-40 і допуск A3/B4. '
    + 'Перед купівлею звірте вʼязкість і допуск із сервісною книжкою вашого авто. Артикул 15C9D0.',
  seo_title: 'Олива Castrol Magnatec 5W-40 A3/B4 4л — 15C9D0',
  seo_description: 'Моторна олива Castrol Magnatec 5W-40 A3/B4, каністра 4 л, артикул 15C9D0. Замовляйте з доставкою по Україні.',
}
const withText = (extra: string): TextFields => ({ ...good, description: good.description + ' ' + extra })

describe('automatic check of a product text before it goes to the site', () => {
  it('a text made only of the product facts passes without a person', () => {
    expect(guardProductText(oil, good)).toEqual([])
  })

  it('an invented number is caught: volume, year, interval, percent', () => {
    expect(guardProductText(oil, withText('Інтервал заміни 15000 км.')).join(' ')).toMatch(/числа, яких немає в даних товару: 15000/)
    expect(guardProductText(oil, withText('Каністра 5 л.')).join(' ')).toMatch(/розмір чи обʼєм, якого немає в даних товару: 5 л/)
    expect(guardProductText(oil, withText('Каністра 1 л.')).join(' ')).toMatch(/числа, яких немає в даних товару: 1/)
    expect(guardProductText(oil, withText('Знижує знос на 50%.')).join(' ')).toMatch(/50/)
  })

  it('an invented car, brand or standard is caught; common marks and words from the product are not', () => {
    expect(guardProductText(oil, withText('Підходить для Volkswagen Passat і Skoda Octavia.')).join(' ')).toMatch(/назви, яких немає в даних товару: volkswagen, passat, skoda, octavia/)
    expect(guardProductText(oil, withText('Відповідає класу API і ACEA, допуск MB-Approval.')).join(' ')).toMatch(/назви, яких немає в даних товару: mb-approval/)
    expect(guardProductText(oil, withText('Олива Castrol класу SAE.'))).toEqual([])
  })

  it('promises, prices, purchase words and Russian text are caught', () => {
    const problems = (extra: string) => guardProductText(oil, withText(extra)).join(' | ')
    expect(problems('Гарантія якості.')).toMatch(/обіцянка, якої немає в даних: гарантія/)
    expect(problems('Найкраща олива на ринку.')).toMatch(/найкращий/)
    expect(problems('Оригінал, вироблено в Німеччині.')).toMatch(/оригінал/)
    expect(problems('Всього 899 грн.')).toMatch(/у тексті є ціна/)
    expect(problems('Наш постачальник привозить щотижня.')).toMatch(/закупівлю, націнку чи постачальника/)
    expect(problems('Подходит для любых двигателей, это лучший выбор.')).toMatch(/текст не українською/)
  })

  it('a Russian word that is part of the product name is not an error; «original» is allowed when the card says so (letter «s» check)', () => {
    const wiper: ProductFacts = { name: 'Щетка стеклоочистителя гибкая Elegant Hybrid 600 мм EL 300360 s', sku: '300360', brand: 'Elegant', category: 'Щітки склоочисника' }
    const text: TextFields = {
      description: 'Гібридна щітка склоочисника Elegant Hybrid довжиною 600 мм. У каталозі постачальника позначена як «Щетка стеклоочистителя гибкая». '
        + 'Перед купівлею звірте довжину зі щіткою, що стоїть на авто. Артикул EL 300360.',
      seo_title: 'Щітка склоочисника Elegant Hybrid 600 мм — EL 300360',
      seo_description: 'Гібридна щітка склоочисника Elegant Hybrid, довжина 600 мм, артикул EL 300360. Замовляйте з доставкою по Україні.',
    }
    expect(guardProductText(wiper, text).filter(problem => !/постачальник/.test(problem))).toEqual([])
    const original: ProductFacts = { ...oil, name: oil.name + ' оригінал' }
    expect(guardProductText(original, withText('Оригінал.'))).toEqual([])
  })

  it('too short or too long texts are held back', () => {
    expect(guardProductText(oil, { ...good, description: 'Олива Castrol.' }).join(' ')).toMatch(/опис закороткий/)
    expect(guardProductText(oil, { ...good, seo_title: 'Олива Castrol Magnatec 5W-40 A3/B4 4л — 15C9D0 '.repeat(2).trim() }).join(' ')).toMatch(/заголовок для пошуковика задовгий/)
    expect(guardProductText(oil, { ...good, seo_description: good.description }).join(' ')).toMatch(/опис для пошуковика задовгий/)
  })

  it('reads the model answer by product numbers and ignores foreign or repeated ones', () => {
    const reply = 'Ось результат:\n{"items":[{"n":3,"description":" A  b ","seo_title":"T\\n t","seo_description":"D"},{"n":9,"description":"x"},{"n":3,"description":"двічі"}]}'
    const parsed = parseTextReply(reply, new Set([3, 4]))
    expect([...parsed.keys()]).toEqual([3])
    expect(parsed.get(3)).toEqual({ description: 'A b', seo_title: 'T t', seo_description: 'D' })
    expect(parseTextReply('не JSON', new Set([1])).size).toBe(0)
  })

  it('helpers: numbers and latin words are compared in a normal form; the product line carries only shop-window facts', () => {
    expect(numbersIn('5,0 л; 05; 5W-40')).toEqual(['5', '40'])
    expect(measuresIn('4л, 600 мм, 12V, 5W-40, 60Ah')).toEqual(['4:л', '600:мм', '12:в', '60:аг'])
    expect(latinWordsIn('Castrol MB-Approval x A3')).toEqual(['castrol', 'mb-approval', 'a3'])
    const line = productLine(7, oil)
    expect(line).toContain('№7 | назва: Олива моторна Castrol Magnatec 5W-40 A3/B4 4л | артикул: 15C9D0 | бренд: Castrol')
    expect(line).toContain('номери-аналоги: 156E9E')
    expect(textJobPrompt('коротше, без слова купити')).toContain('ПОБАЖАННЯ ВЛАСНИКА ДО СТИЛЮ')
    expect(textJobPrompt(null)).not.toContain('ПОБАЖАННЯ ВЛАСНИКА')
  })
})
