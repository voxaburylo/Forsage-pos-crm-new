import { describe, expect, it, vi } from 'vitest'
import { applyApprovedPhotos, collectBatch, initialPicks, isOurAiPhoto, jobText, togglePick, worstCaseCalls, type CheckedPhoto, type PhotoAiJob } from './photoAiApi'
import { isWebReadOnlyRequest } from '@/lib/api'

// 27.11.2026: «Пошук фото з ШІ». У даних навмисно є літера «s» (правило власника про регулярні вирази).
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ours = (n: number) => `https://x.supabase.co/storage/v1/object/public/product-photos/ai/${id(99)}/${id(n)}/abcs${n}.webp`
const photo = (url: string, ok: boolean): CheckedPhoto => ({ image_url: url, thumb_url: '', title: '', domain: 'shop.example', page_url: '', width: 900, height: 900, score: 5, ok, reason: ok ? 'підходить' : 'на фото інший товар' })

describe('choosing photos in the product card', () => {
  it('ticks what the AI approved, best first, not more than allowed', () => {
    const photos = [photo('a', true), photo('b', false), photo('c', true), photo('d', true)]
    expect(initialPicks(photos, 2)).toEqual(['a', 'c'])
    expect(initialPicks([photo('b', false)], 3)).toEqual([])
  })

  it('the first ticked one is the main photo; a person may tick a rejected one; the limit holds', () => {
    let picked = togglePick([], 'b', 2)
    picked = togglePick(picked, 'a', 2)
    expect(picked).toEqual(['b', 'a'])
    expect(togglePick(picked, 'c', 2)).toEqual(['b', 'a'])
    expect(togglePick(picked, 'b', 2)).toEqual(['a'])
  })
})

describe('the bulk batch', () => {
  it('takes only till cards without a photo that were not searched lately, and stops at the wanted size', async () => {
    const pages = [
      [{ id: id(1), name: 'Фільтр s 1', photo_url: 'file:///C:/photos/own.jpg' }, { id: id(2), name: ' Фільтр s 2 ', sku: 'S-2', brand: { name: 'Bosch' } }, { id: id(3), name: 'Шиномонтаж', is_service: true }, { id: 'local-7', name: 'Без коду' }],
      [{ id: id(4), name: 'Фільтр s 4' }, { id: id(5), name: 'Фільтр s 5' }, { id: id(6), name: 'Фільтр s 6' }],
      [{ id: id(7), name: 'Фільтр s 7' }],
    ]
    const listPage = vi.fn(async (page: number) => ({ data: pages[page - 1] ?? [], total_pages: 3 }))
    const eligible = vi.fn(async (ids: string[]) => ids.filter(value => value !== id(4)))
    const batch = await collectBatch(3, { listPage, eligible })
    expect(batch).toEqual([{ id: id(2), name: 'Фільтр s 2', sku: 'S-2', brand: 'Bosch' }, { id: id(5), name: 'Фільтр s 5', sku: null, brand: null }, { id: id(6), name: 'Фільтр s 6', sku: null, brand: null }])
    expect(eligible).toHaveBeenNthCalledWith(1, [id(2)])
    expect(listPage).toHaveBeenCalledTimes(2)
    expect(await collectBatch(50, { listPage, eligible })).toHaveLength(4)
  })

  it('shows the worst case in paid requests and the progress', () => {
    expect(worstCaseCalls(20)).toEqual({ serper: 20, gemini: 120 })
    const job: PhotoAiJob = { id: id(1), mode: 'review', status: 'running', stop_reason: null, stop_text: null, total: 20, done: 7, found: 4, serper_calls: 7, gemini_calls: 30, waiting_until: null, created_at: '', finished_at: null }
    expect(jobText(job)).toBe('Шукаю: готово 7 з 20, з фото — 4. Екран можна закрити.')
    expect(jobText({ ...job, waiting_until: '2026-11-27T10:00:00Z' })).toContain('продовжу сам')
    expect(jobText({ ...job, status: 'stopped', stop_reason: 'serper_credits', stop_text: 'На рахунку Serper.dev закінчились кредити.' })).toBe('На рахунку Serper.dev закінчились кредити. (готово 7 з 20, з фото — 4)')
    expect(jobText({ ...job, status: 'done', done: 20 })).toBe('Партію закінчено: готово 20 з 20, з фото — 4.')
    expect(jobText(null)).toBe('Партій ще не було.')
  })
})

describe('putting found photos into cards', () => {
  it('never replaces a photo that is already in the card', async () => {
    const cards: Record<string, { id: string; photo_url?: string | null }> = {
      [id(1)]: { id: id(1), photo_url: null }, [id(2)]: { id: id(2), photo_url: 'file:///C:/photos/own-s.jpg' }, [id(3)]: { id: id(3), photo_url: ours(3) }, [id(5)]: { id: id(5) },
    }
    const setCardPhoto = vi.fn(async (cardId: string) => { if (cardId === id(5)) throw new Error('каса зайнята') })
    const report = vi.fn(async () => undefined)
    const result = await applyApprovedPhotos({
      list: async () => [{ product_id: id(1), url: ours(1) }, { product_id: id(2), url: ours(2) }, { product_id: id(3), url: ours(3) }, { product_id: id(4), url: ours(4) },
        { product_id: id(5), url: ours(5) }, { product_id: id(6), url: 'https://evil.example/a.webp' }],
      findCard: async cardId => cards[cardId] ?? null, setCardPhoto, report,
    })
    expect(setCardPhoto.mock.calls.map(call => call[0])).toEqual([id(1), id(5)])
    expect(setCardPhoto).toHaveBeenCalledWith(id(1), ours(1))
    // 1 — поставлено, 3 — уже стояло; 2 — своє фото, 4 — картки немає; 5 — збій (спробуємо ще), 6 — чужа адреса.
    expect(report).toHaveBeenCalledWith([id(1), id(3)], [id(2), id(4)])
    expect(result).toEqual({ applied: 2, skipped: 2, failed: 2 })
  })

  it('reports nothing when there is nothing to report', async () => {
    const report = vi.fn(async () => undefined)
    expect(await applyApprovedPhotos({ list: async () => [], findCard: async () => null, setCardPhoto: async () => undefined, report })).toEqual({ applied: 0, skipped: 0, failed: 0 })
    expect(report).not.toHaveBeenCalled()
  })

  it('accepts only addresses of our own "ai" folder', () => {
    expect(isOurAiPhoto(ours(1))).toBe(true)
    expect(isOurAiPhoto('http://x.supabase.co/storage/v1/object/public/product-photos/ai/a/b/c.webp')).toBe(false)
    expect(isOurAiPhoto('https://x.supabase.co/storage/v1/object/public/product-photos/own/c.webp')).toBe(false)
    expect(isOurAiPhoto('https://x.supabase.co/storage/v1/object/public/product-photos/ai/a/b/c.jpg')).toBe(false)
    expect(isOurAiPhoto(null)).toBe(false)
  })
})

describe('the web may use the feature', () => {
  it('its requests are not blocked as "web is read-only"', () => {
    expect(isWebReadOnlyRequest('/api/v1/ai/photo-ai/search', 'POST')).toBe(false)
    expect(isWebReadOnlyRequest('/api/v1/ai/photo-ai/keys', 'POST')).toBe(false)
    expect(isWebReadOnlyRequest('/api/v1/ai/photo-aix', 'POST')).toBe(true)
  })
})
