import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { desktopServerRetryDelay } from './auth'

/**
 * 06.09.2026 каса цілий день не синхронізувалася: 31 операція, з них 27 чеків,
 * стояли в черзі, і жодної спроби відправки навіть не було. Причина — вхід
 * стався офлайн (вранці Render ще спав), а спроби підняти серверну сесію
 * закінчувалися після трьох невдач. Офлайн-режим лишався до перезапуску, а в
 * ньому синхронізатор не працює взагалі. Ні помилки, ні значка — тиша.
 */
describe('відновлення звʼязку з сервером після офлайн-входу', () => {
  it('паузи між спробами ростуть, але спроби не закінчуються', () => {
    expect(desktopServerRetryDelay(0)).toBe(5_000)
    expect(desktopServerRetryDelay(1)).toBe(15_000)
    expect(desktopServerRetryDelay(2)).toBe(60_000)
    expect(desktopServerRetryDelay(3)).toBe(300_000)

    // Головне: після останнього значення спроби тривають далі з тією ж паузою.
    for (const attempt of [4, 10, 100, 5_000]) {
      expect(desktopServerRetryDelay(attempt)).toBe(300_000)
    }
  })

  it('перевірка звʼязку чекає довше, ніж прокидається сплячий сервер', () => {
    const source = readFileSync(new URL('../hooks/useServerStatus.ts', import.meta.url), 'utf8')
    const timeout = /const TIMEOUT_MS = ([0-9_]+)/.exec(source)
    expect(timeout).not.toBeNull()
    // Render після ночі відповідає 20-25 секунд (заміряно 21,4 с). Коротший
    // таймаут означав би «інтернету немає» щоранку.
    expect(Number(timeout![1].replace(/_/g, ''))).toBeGreaterThanOrEqual(25_000)
  })
})
