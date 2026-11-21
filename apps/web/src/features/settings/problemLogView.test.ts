import { expect, it } from 'vitest'
import { isStaleProblem, problemDetail, problemTitle } from './problemLogView'

it('names till commands in plain words', () => {
  expect(problemTitle('Команда каси «desktop:pos:checkout» завершилась помилкою')).toBe('Продаж на касі: помилка')
  expect(problemTitle('Команда каси «desktop:print:labels-tspl» завершилась помилкою')).toBe('Друк етикеток: помилка')
  expect(problemTitle('Інша проблема')).toBe('Інша проблема')
})

it('turns technical details into a readable sentence', () => {
  expect(problemDetail('Технічна помилка; причину можна зіставити за відбитком [unknown]. Відбиток: 5383e75496a0b4e46b24.'))
    .toBe('Причина не розпізнана. Якщо повторюється — повідомте розробнику (код 5383e754).')
  expect(problemDetail('Недостатньо залишку для цієї операції [insufficient-stock]. Відбиток: 0d28ccb2447e90c069b9.'))
    .toBe('Недостатньо залишку для цієї операції.')
})

it('treats problems not seen for two weeks as old', () => {
  const now = Date.parse('2026-11-21T12:00:00Z')
  expect(isStaleProblem('2026-09-14T13:58:28Z', now)).toBe(true)
  expect(isStaleProblem('2026-11-20T15:39:05Z', now)).toBe(false)
})
