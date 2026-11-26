import { describe, expect, it } from 'vitest'
import { claimsDoneInText, ownerOnlyAsks, replyCorrection } from './aiReplyReview.js'

// 26.11.2026, чат власника: на запитання про рядок накладної помічник відповів двічі, і власник побачив лише
// «Це було лише запитання, інструмент я не викликав. Моя попередня відповідь була порадою…».
const question = 'Не проводиться рядок накладної «Запобіжники WTE M-10» (артикул 111). Програма пише: «Є кілька товарів із точною назвою». Що це означає і що мені зробити? Нічого не змінюй сам — підкажи, що натиснути.'
const advice = 'Це означає, що в базі вже є дві картки з такою назвою. Щоб додати товар у потрібну, виберіть картку 82305 у рядку; нову картку створювати не треба — інакше створиться ще один дубль. Готові картки: 82305 і 81072.'

describe('the reply guard asks for a second answer only when the assistant really reported a deed it did not do', () => {
  it('advice on an owner question is accepted as is (letter «s» check: «WTE M-10 s»)', () => {
    expect(ownerOnlyAsks(question)).toBe(true)
    expect(replyCorrection({ reply: advice, userText: question, actions: 0, preparedJobs: 0 })).toBeNull()
    expect(replyCorrection({ reply: advice + ' s', userText: 'поясни помилку s', actions: 0, preparedJobs: 0 })).toBeNull()
  })

  it('words with the root «дода/створ/готов» are not a report; a first-person past verb is', () => {
    for (const text of ['Щоб додати кроси, відкрийте картку', 'Створіть нову категорію вручну', 'Готові назви зʼявляться у задачах', 'Картку вже додано раніше касиром'])
      expect(claimsDoneInText(text)).toBe(false)
    for (const text of ['Створив 5 клієнтів.', 'Я обʼєднав дублі', 'Готово!', 'Добавил товары', 'Перейменував категорії'])
      expect(claimsDoneInText(text)).toBe(true)
  })

  it('a false «done» without any proposal is corrected, and the model is told the owner did not see the first answer', () => {
    const correction = replyCorrection({ reply: 'Готово, створив 47 клієнтів.', userText: 'заведи клієнтів із файлу', actions: 0, preparedJobs: 0 })
    expect(correction).toMatch(/НЕ підготував жодної пропозиції/)
    expect(correction).toMatch(/попередню відповідь НЕ бачив/)
    expect(replyCorrection({ reply: 'Готово, створив 47 клієнтів.', userText: 'заведи клієнтів', actions: 1, preparedJobs: 0 })).toBeNull()
    expect(replyCorrection({ reply: 'Запустив задачу, готово.', userText: 'наведи порядок у назвах', actions: 0, preparedJobs: 1 })).toBeNull()
  })

  it('asking permission in text and an empty reply are still corrected; an order to act is not «only a question»', () => {
    expect(replyCorrection({ reply: 'Обʼєднати ці 18 пар?', userText: 'знайди дублі', actions: 0, preparedJobs: 0 })).toMatch(/питаєш дозволу текстом/)
    expect(replyCorrection({ reply: '  ', userText: 'привіт', actions: 0, preparedJobs: 0 })).toMatch(/порожньою/)
    expect(ownerOnlyAsks('можеш обʼєднай дублі?')).toBe(false)
    expect(ownerOnlyAsks('скільки є фільтрів?')).toBe(true)
  })
})
