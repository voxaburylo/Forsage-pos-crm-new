import { describe, expect, it } from 'vitest'

const { asksPermissionInText } = await import('../aiPermissionText.js')

describe('chat must propose with a button instead of asking in text', () => {
  it('catches the owner-reported reply (20.11.2026) and similar questions', () => {
    expect(asksPermissionInText('1. Обʼєднати всі 18 пар із таблиці? Основною я б брав картку з більшим залишком.')).toBe(true)
    expect(asksPermissionInText('Скажете «так», і я зроблю одну пропозицію з причиною до кожної пари.')).toBe(true)
    expect(asksPermissionInText("Об'єднати ці дві картки?")).toBe(true)
    expect(asksPermissionInText('Объединить замки EL 101 514?')).toBe(true)
    expect(asksPermissionInText('Перейменувати категорії російською?')).toBe(true)
  })
  it('leaves ordinary answers and clarifying questions alone', () => {
    expect(asksPermissionInText('На складі 5 шт. Ціна 135 грн.')).toBe(false)
    expect(asksPermissionInText('Це ваша картка 87775 «Пістолет продувний»?')).toBe(false)
    expect(asksPermissionInText('Скажете таку назву — і я знайду.')).toBe(false)
  })
})
