import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/supabase.js', () => ({ db: {} }))
vi.mock('./auditService.js', () => ({ logAction: vi.fn() }))

import { catalogCodesFromName, normalizeCatalogCode } from './productService.js'

describe('catalog code extraction', () => {
  it('normalizes punctuation without joining an unrelated brand word', () => {
    expect(normalizeCatalogCode('W811/80')).toBe('W81180')
    expect(catalogCodesFromName('Фільтр MAN W811/80')).toContain('W81180')
    expect(catalogCodesFromName('Фільтр MAN W811/80')).not.toContain('MANW81180')
  })

  it('recognizes a separated short prefix and number', () => {
    expect(catalogCodesFromName('Фільтр MAHLE OC 196')).toContain('OC196')
  })

  it('does not treat ordinary words as catalog codes', () => {
    expect(catalogCodesFromName('Фільтр масляний для двигуна')).toEqual([])
  })
})