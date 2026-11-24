import { describe, expect, it, vi } from 'vitest'
import { AUTO_PHOTO_FOLDER, cleanAutoPhotos, importSitePhotos, isAutoPhoto, sitePhotoImportText, type SitePhotoImportDeps } from './sitePhotoImport'

const P1 = '7b1f0c1e-2a3b-4c4d-8e5f-0123456789a1', P2 = '7b1f0c1e-2a3b-4c4d-8e5f-0123456789a2', P3 = '7b1f0c1e-2a3b-4c4d-8e5f-0123456789a3', P4 = '7b1f0c1e-2a3b-4c4d-8e5f-0123456789a4'
const photo = (id: string, at: string, full = 'https://site.test/p/' + id + '.webp') => ({ program_product_id: id, full, thumb: full, found_at: at })

function setup(list: unknown, cards: Record<string, { id: string; photo_url?: string | null } | null>, over: Partial<SitePhotoImportDeps> = {}) {
  let since: string | null = null
  const deps: SitePhotoImportDeps = {
    list: vi.fn(async () => list), findCard: vi.fn(async id => cards[id] ?? null),
    download: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer), savePhoto: vi.fn(async folder => 'file:///C:/Forsage/photos/' + folder + '/1.webp'),
    setCardPhoto: vi.fn(async () => undefined), deletePhoto: vi.fn(async () => undefined),
    readSince: () => since, writeSince: value => { since = value }, ...over,
  }
  return { deps, since: () => since }
}

// 24.11.2026 (доповнення 3 розробника сайту): фото, знайдені сайтом, забирає головний ПК.
describe('import of photos found by the site', () => {
  it('takes only well-formed entries and goes in the order they were found', () => {
    const cleaned = cleanAutoPhotos([photo(P2, '2026-11-24T11:00:00Z'), photo(P1, '2026-11-24T10:00:00Z'), photo('nope', '2026-11-24T10:00:00Z'),
      photo(P3, '2026-11-24T10:00:00Z', 'http://site.test/a.webp'), photo(P3, 'yesterday'), null, 'x'])
    expect(cleaned.map(item => item.program_product_id)).toEqual([P1, P2])
    expect(cleanAutoPhotos({})).toEqual([])
  })

  it('puts a photo only into a card without one; the program own photo is never replaced', async () => {
    const { deps, since } = setup([photo(P1, '2026-11-24T10:00:00Z'), photo(P2, '2026-11-24T11:00:00Z'), photo(P3, '2026-11-24T12:00:00Z')],
      { [P1]: { id: P1, photo_url: null }, [P2]: { id: P2, photo_url: 'file:///C:/own.jpg' } })
    const result = await importSitePhotos(deps)
    expect(result).toMatchObject({ received: 3, added: 1, skippedHasPhoto: 1, skippedNoCard: 1, failed: 0 })
    expect(deps.setCardPhoto).toHaveBeenCalledTimes(1)
    expect(deps.savePhoto).toHaveBeenCalledWith(AUTO_PHOTO_FOLDER + '-' + P1, expect.anything())
    const saved = (deps.setCardPhoto as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(isAutoPhoto(saved)).toBe(true); expect(isAutoPhoto('file:///C:/Forsage/photos/product/own.jpg')).toBe(false)
    expect(since()).toBe('2026-11-24T12:00:00Z')
    expect(sitePhotoImportText(result)).toContain('додано в картки: 1')
  })

  it('a photo that failed is asked again next time: the mark stops before it', async () => {
    const download = vi.fn(async (url: string) => { if (url.includes(P2)) throw new Error('net'); return new Uint8Array([1]).buffer })
    const { deps, since } = setup([photo(P1, '2026-11-24T10:00:00Z'), photo(P2, '2026-11-24T11:00:00Z'), photo(P4, '2026-11-24T12:00:00Z')],
      { [P1]: { id: P1 }, [P2]: { id: P2 }, [P4]: { id: P4 } }, { download })
    expect(await importSitePhotos(deps)).toMatchObject({ added: 2, failed: 1 })
    expect(since()).toBe('2026-11-24T10:00:00Z')
  })

  it('a file that could not be attached to the card is removed; too big or empty files are refused', async () => {
    const { deps } = setup([photo(P1, '2026-11-24T10:00:00Z')], { [P1]: { id: P1 } }, { setCardPhoto: vi.fn(async () => { throw new Error('db') }) })
    expect(await importSitePhotos(deps)).toMatchObject({ added: 0, failed: 1 })
    expect(deps.deletePhoto).toHaveBeenCalledTimes(1)
    const big = setup([photo(P1, '2026-11-24T10:00:00Z')], { [P1]: { id: P1 } }, { download: vi.fn(async () => new ArrayBuffer(4 * 1024 * 1024)) })
    expect(await importSitePhotos(big.deps)).toMatchObject({ added: 0, failed: 1 })
    expect(big.deps.savePhoto).not.toHaveBeenCalled()
    expect(sitePhotoImportText({ received: 0, added: 0, skippedHasPhoto: 0, skippedNoCard: 0, failed: 0, since: null })).toBe('Нових фото від сайту немає.')
  })
})
