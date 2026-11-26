import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// 26.11.2026, власник (скрин з телефона): «незрозуміле вікно знизу, за вікном текст неможливо прочитати; чекав 5 хв — 0%».
describe('assistant background jobs panel does not eat the chat', () => {
  const panel = readFileSync(new URL('./AiJobsPanel.tsx', import.meta.url), 'utf8')
  it('is folded by default and never opens by itself; open, it scrolls inside a limited height', () => {
    expect(panel).not.toMatch(/open=\{open\.length > 0/)
    expect(panel).toContain('[&[open]>div]:max-h-[45vh]')
  })
  it('the folded line says when a job waits for its start or is ready for review', () => {
    expect(panel).toContain('чекає запуску')
    expect(panel).toContain('готово — перегляньте')
  })
})
