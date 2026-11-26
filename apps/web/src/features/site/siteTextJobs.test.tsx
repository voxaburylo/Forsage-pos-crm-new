import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(async () => ({ data: [] })), post: vi.fn(async () => ({ data: {} })) } }))
import { etaText, isOpen, textJobLine, type TextJob } from './siteTextJobs'
import { SiteTextJobPanel } from './SiteTextJobPanel'

// 26.11.2026, власник: «великі пачки, без купи підтверджень і всього червоного; зручно й тактовно».
const job = (over: Partial<TextJob>): TextJob => ({ id: 'j', scope: 'in_stock', overwrite: false, style_note: null, status: 'running', total: 6485, processed: 1240, written: 1180,
  review: 37, skipped: 20, failed: 3, cost_usd: 4.2, last_error: null, progress: 19, created_at: '', updated_at: '', ...over })

describe('mass product texts for the site: one calm status line, one decision from the owner', () => {
  it('says in one line what is going on and whether anything is needed from the owner', () => {
    expect(textJobLine(job({ status: 'sample', processed: 0, written: 0, review: 0, skipped: 0, failed: 0 }))).toMatch(/Готую 10 зразків із 6.485 товарів.*На сайт поки нічого не записано/)
    expect(textJobLine(job({ status: 'sample_ready' }))).toMatch(/Зразки готові.*далі я пройду всі 6.485 товарів сам/)
    const running = textJobLine(job({}))
    expect(running).toMatch(/Працюю: 1.240 з 6.485 \(19%\)/)
    expect(running).toMatch(/на сайті 1.180 · уже мали опис 20 · відкладено на ваш погляд 37 · не вдалося 3/)
    expect(running).toMatch(/Екран можна закрити/)
    expect(textJobLine(job({ status: 'cancelled', written: 0, review: 0, skipped: 0, failed: 0 }))).toBe('Скасовано. На сайті — як було.')
    expect(textJobLine(job({ status: 'done' }))).toMatch(/^Готово: на сайті/)
  })

  it('an honest time estimate and what counts as work in progress', () => {
    expect(etaText(240)).toBe('10 хв')
    expect(etaText(5245)).toBe('3,7 год')
    expect(isOpen(job({ status: 'paused' }))).toBe(true)
    expect(isOpen(job({ status: 'done' }))).toBe(false)
    expect(isOpen(null)).toBe(false)
  })

  it('before the start there is one button; no red or amber anywhere in the panel', () => {
    const html = renderToStaticMarkup(<SiteTextJobPanel />)
    expect(html).toContain('Почати — спершу 10 зразків')
    expect(html).toContain('Товари в наявності')
    expect(html).not.toMatch(/red-|amber-|rose-/)
  })
})
