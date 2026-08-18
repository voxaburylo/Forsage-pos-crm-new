import { describe, expect, it } from 'vitest'
import { parseAiJsonObject } from './aiInvoiceResponse.js'

describe('parseAiJsonObject', () => {
  it('parses a normal structured response', () => {
    expect(parseAiJsonObject('{"products":[{"name":"Фільтр"}]}')).toEqual({
      products: [{ name: 'Фільтр' }],
    })
  })

  it('recovers JSON wrapped in markdown or explanatory text', () => {
    expect(parseAiJsonObject('```json\n{"products":[{"name":"Олива"}]}\n```')).toEqual({
      products: [{ name: 'Олива' }],
    })
    expect(parseAiJsonObject('Ось таблиця: {"products":[{"name":"Лампа"}]} готово')).toEqual({
      products: [{ name: 'Лампа' }],
    })
  })

  it('rejects empty and truncated responses instead of inventing rows', () => {
    expect(parseAiJsonObject('')).toBeNull()
    expect(parseAiJsonObject('{"products":[{"name":"Незавершено"}')).toBeNull()
  })
})