import { describe, expect, it } from 'vitest'
import { applyArticle, applyForumPost, applyProductTexts, applySectionSeo, applySiteSeo, SEO_QUICK, seoHistory, type SeoCall } from './siteSeo'
import { forumStatsLine, forumTextProblem } from './siteForum'

// Помічник сайту: підтверджене власником записується на сайт через шлюз (кожна зміна — в журнал аудиту на сервері).
describe('site SEO assistant: confirmed proposals are written through the site gateway', () => {
  it('product texts go as one batch; only the given fields are sent; «not on site» is reported (letter «s» check)', async () => {
    const calls: Array<[string, any]> = []
    const call = (async (action: string, params?: Record<string, unknown>) => { calls.push([action, params]); return { saved: 1, not_on_site: ['p2'] } }) as SeoCall
    const result = await applyProductTexts([
      { product_id: 'p1', name: 'Олива s', sku: '1', seo_title: 'Олива Castrol 5W-40', seo_keywords: 'олива 5W-40, Castrol', notes: [] },
      { product_id: 'p2', name: 'Свічка', sku: null, description: 'Новий опис', notes: [] },
    ], call)
    expect(calls).toEqual([['seo.products.set', { items: [
      { program_product_id: 'p1', seo_title: 'Олива Castrol 5W-40', seo_keywords: 'олива 5W-40, Castrol' },
      { program_product_id: 'p2', description: 'Новий опис' },
    ] }]])
    expect(result).toEqual({ done: 1, failed: [{ item: 'Свічка', error: 'цього товару немає на сайті' }] })
    const down = (async () => { throw new Error('сайт не відповів') }) as SeoCall
    expect((await applyProductTexts([{ product_id: 'p1', name: 'Олива', sku: null, seo_title: 't', notes: [] }], down)).failed).toEqual([{ item: 'Олива', error: 'сайт не відповів' }])
  })

  it('catalogue sections are written one by one; a failure of one does not stop the rest', async () => {
    const sent: any[] = []
    const call = (async (_action: string, params?: Record<string, unknown>) => { if (params?.id === '2') throw new Error('сайт не прийняв'); sent.push(params); return null }) as SeoCall
    const faq = [{ q: 'Яку вʼязкість вибрати?', a: 'Ту, що в сервісній книжці.' }]
    const result = await applySectionSeo([{ id: '1', name: 'Оливи', seo_title: 'Моторні оливи', faq, notes: [] }, { id: '2', name: 'Шини', description: 'Текст', notes: [] }], call)
    expect(sent).toEqual([{ id: '1', seo_title: 'Моторні оливи', faq }])
    expect(result).toEqual({ done: 1, failed: [{ item: 'Шини', error: 'сайт не прийняв' }] })
  })

  it('forum: a new topic and a reply are published as the shop', async () => {
    const calls: Array<[string, unknown]> = []
    const call = (async (action: string, params?: Record<string, unknown>) => { calls.push([action, params]); return { url: '/forum/99-tema' } }) as SeoCall
    expect(await applyForumPost({ id: 'a', kind: 'forum_post', title: 'Тема форуму: X', post_kind: 'topic', section: 'khodova', topic_id: null, topic_title: 'Биття керма', body: 'Текст' }, call)).toBe('/forum/99-tema')
    await applyForumPost({ id: 'b', kind: 'forum_post', title: 'Відповідь', post_kind: 'reply', section: '', topic_id: '12', topic_title: 'Шипи', body: 'Відповідь' }, call)
    expect(calls).toEqual([['forum.topics.create', { section: 'khodova', title: 'Биття керма', body: 'Текст' }], ['forum.posts.create', { topic_id: '12', body: 'Відповідь' }]])
    await expect(applyForumPost({ id: 'c', kind: 'forum_post', title: 't', post_kind: 'reply', section: '', topic_id: null, topic_title: '', body: 'x' }, call)).rejects.toThrow(/тему/)
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
        { id: 'y', kind: 'forum_post', title: 'Тема', post_kind: 'topic', section: 's', topic_id: null, topic_title: 'Тема', body: 'b' },
      ] },
    ], { x: 'записано на сайт' })
    expect(history[0]).toEqual({ role: 'user', text: 'описи' })
    expect(history[1].text).toContain('«Головна»: записано на сайт')
    expect(history[1].text).toContain('«Тема»: власник ще не підтвердив')
    expect(SEO_QUICK.length).toBeGreaterThanOrEqual(5)
  })
})

describe('forum tab helpers', () => {
  it('a topic needs a section, a searchable title and a real text; a reply needs any text', () => {
    expect(forumTextProblem('topic', 'Биття керма на 100 км/год', 'Текст '.repeat(10), '')).toMatch(/розділ/)
    expect(forumTextProblem('topic', 'Керм', 'Текст '.repeat(10), 's')).toMatch(/Заголовок/)
    expect(forumTextProblem('topic', 'Биття керма на 100 км/год', 'мало', 's')).toMatch(/текст теми/)
    expect(forumTextProblem('topic', 'Биття керма на 100 км/год', 'Текст '.repeat(10), 's')).toBe('')
    expect(forumTextProblem('reply', '', ' ')).toMatch(/відповідь/)
    expect(forumTextProblem('reply', '', 'ок')).toBe('')
  })
  it('the weekly statistics line shows the numbers the site gave, in plain words', () => {
    expect(forumStatsLine({ new_topics: 4, replies: 12, new_customers: 2, popular: [{ id: 1 }] }, 7)).toBe('За 7 днів: 4 нових тем · 12 відповідей · 2 нових покупців.')
    expect(forumStatsLine(null, 7)).toBe('')
    expect(forumStatsLine({ something: 'x' }, 7)).toBe('')
  })
})
