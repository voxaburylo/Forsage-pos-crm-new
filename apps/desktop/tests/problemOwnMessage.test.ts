import { describe, expect, it } from 'vitest'
import { ownMessage, safeProblemDetail } from '../src/diagnostics/problemDetails'

describe('problem journal shows the program’s own reason instead of [unknown] (20.11.2026)', () => {
  it('keeps the Ukrainian reason and hides quoted names and long numbers', () => {
    expect(ownMessage('Сесію ревізії вже завершено. Оновіть сторінку.')).toBe('Сесію ревізії вже завершено. Оновіть сторінку.')
    expect(ownMessage('Картку «Фільтр WIX WL7129» змінено на іншому ПК, телефон 380635550000')).toBe('Картку «…» змінено на іншому ПК, телефон …')
    const detail = safeProblemDetail('Сесію ревізії вже завершено', 'ipc.desktop:inventory:delete-session')!
    expect(detail).toMatch(/^Сесію ревізії вже завершено \[message\]\. Відбиток: [a-f0-9]{20}\.$/)
  })
  it('technical or foreign text stays a fingerprint', () => {
    expect(ownMessage('SQLITE_BUSY: database is locked')).toBeNull()
    expect(ownMessage('Помилка at Object.<anonymous> (main.js:1:1)')).toBeNull()
    expect(ownMessage('Лист на user@example.com не надіслано')).toBeNull()
    expect(safeProblemDetail('TypeError: x is undefined', 'ipc.desktop:pos:checkout')).toMatch(/\[unknown\]/)
  })
})
