import { describe, expect, it, vi } from 'vitest'
import { applyArticle, applyProductTexts, applySiteSeo, SEO_QUICK, seoHistory, type SeoCall } from './siteSeo'

// 26.11.2026: помічник сайту пише описи й SEO-поля; те, чого він не чіпав, на сайті має лишитись як було.
describe('site SEO assistant: confirmed proposals are written through the site gateway', () => {
  it('merges with what the site has now; a product that could not be read is not overwritten (letter «s» check)', async () => {
    const sets: Array<Record<string, unknown>> = []
    const call = (async (action: string, params: Record<string, unknown> = {}) => {
      if (action === 'products.site_fields.get') {
        if (params.program_product_id === 'p2') throw new Error('сайт не відповів')
        return { description: 'Старий опис s', specs: { size: '5W-40' }, hidden: true, seo_title: 'Старий заголовок' }
      }
      sets.push(params); return null
    }) as SeoCall
    const progress = vi.fn()
    const result = await applyProductTexts([
      { product_id: 'p1', name: 'Олива s', sku: '1', seo_description: 'Новий опис для пошуковика', notes: [] },
      { product_id: 'p2', name: 'Свічка', sku: null, description: 'Новий', notes: [] },
    ], call, progress)
    expect(result).toEqual({ done: 1, failed: [{ item: 'Свічка', error: 'сайт не відповів' }] })
    expect(sets).toEqual([{ program_product_id: 'p1', description: 'Старий опис s', specs: { size: '5W-40' }, hidden: true, seo_title: 'Старий заголовок', seo_description: 'Новий опис для пошуковика' }])
    expect(progress).toHaveBeenLastCalledWith(2)
  })

  it('a new article is created; an edited one keeps its picture and kind; a vanished one is not recreated silently', async () => {
    const calls: Array<[string, unknown]> = []
    const call = (async (action: string, params?: Record<string, unknown>) => {
      calls.push([action, params])
      return action === 'pages.list' ? [{ id: 7, type: 'article', image_url: 'https://x/a.webp' }] : null
    }) as SeoCall
    await applyArticle({ id: 'a', kind: 'article', title: 'Стаття: Шипи чи липучка', page_id: null, content: 'Текст', words: 1 }, call)
    await applyArticle({ id: 'b', kind: 'article', title: 'Стаття: Оновлена', page_id: '7', content: 'Новий текст', words: 2 }, call)
    expect(calls[0]).toEqual(['pages.upsert', { type: 'article', title: 'Шипи чи липучка', content: 'Текст', image_url: null }])
    expect(calls[2]).toEqual(['pages.upsert', { id: 7, type: 'article', title: 'Оновлена', content: 'Новий текст', image_url: 'https://x/a.webp' }])
    await expect(applyArticle({ id: 'c', kind: 'article', title: 'Стаття: X', page_id: '99', content: 'T', words: 1 }, call)).rejects.toThrow(/вже немає/)
  })

  it('home page SEO changes only its two fields and sends the other settings back unchanged', async () => {
    let sent: unknown
    const call = (async (action: string, params?: Record<string, unknown>) => {
      if (action === 'settings.set') sent = params
      return { seo_title: 'Старий', seo_description: 'Опис', contact_phone1: '+380', extra_unknown: 'x' }
    }) as SeoCall
    await applySiteSeo({ id: 's', kind: 'site_seo', title: 't', seo_title: 'Новий заголовок', seo_description: '' }, ['seo_title', 'seo_description', 'contact_phone1', 'fb_pixel_id'], call)
    expect(sent).toEqual({ values: { seo_title: 'Новий заголовок', seo_description: 'Опис', contact_phone1: '+380', fb_pixel_id: '' } })
  })

  it('tells the assistant how its proposals ended and starts the history with the owner', () => {
    const history = seoHistory([
      { role: 'model', text: 'стара відповідь' }, { role: 'user', text: 'описи' },
      { role: 'model', text: 'Підготував.', actions: [
        { id: 'x', kind: 'site_seo', title: 'Головна', seo_title: 'a', seo_description: '' },
        { id: 'y', kind: 'forum_post', title: 'Тема', post_kind: 'topic', section: '', body: 'b' },
      ] },
    ], { x: 'записано на сайт' })
    expect(history[0]).toEqual({ role: 'user', text: 'описи' })
    expect(history[1].text).toContain('«Головна»: записано на сайт')
    expect(history[1].text).toContain('«Тема»: текст показано власнику')
    expect(SEO_QUICK.length).toBeGreaterThanOrEqual(4)
  })
})
