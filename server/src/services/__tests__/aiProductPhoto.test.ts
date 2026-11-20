import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/supabase.js', () => ({ db: {} }))
vi.mock('../aiService.js', () => ({ getAiConfig: vi.fn(), recordAiUsage: vi.fn() }))
vi.mock('../aiClaude.js', () => ({ ClaudeClient: vi.fn() }))
const {
  pageHasArticle, extractProductImage, isPrivateAddress, safeFetch, parseCandidatePages, verifyCandidate, imageMime, normalizeArticle,
} = await import('../aiProductPhotoService.js')

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, 1)])
const page = (body: string, head = '') => `<html><head>${head}</head><body>${body}</body></html>`
const signal = new AbortController().signal

describe('product photos from the internet', () => {
  it('requires the exact article on the page, tolerating spaces and dashes', () => {
    expect(pageHasArticle(page('<p>Щітка склоочисника WA6684 500 мм</p>'), 'WA6684')).toBe(true)
    expect(pageHasArticle(page('<p>Артикул: WA 6684</p>'), 'wa-6684')).toBe(true)
    expect(pageHasArticle(page('<p>WA66845 інший товар</p>'), 'WA6684')).toBe(false)
    expect(pageHasArticle(page('<p>WA668</p>'), 'WA6684')).toBe(false)
    expect(pageHasArticle(page('<script>var sku="WA6684"</script><p>інше</p>'), 'WA6684')).toBe(false)
    expect(pageHasArticle(page('<p>x</p>'), 'H7')).toBe(false)
    expect(normalizeArticle(' 4335M20-8 ')).toBe('4335m208')
  })

  it('takes the product image from JSON-LD first, then og:image', () => {
    const ld = '<script type="application/ld+json">{"@type":"Product","image":["/img/a.jpg"]}</script>'
    expect(extractProductImage(page('', ld + '<meta property="og:image" content="https://x.ua/og.jpg">'), 'https://shop.ua/p/1')).toBe('https://shop.ua/img/a.jpg')
    expect(extractProductImage(page('', '<meta property="og:image" content="//cdn.x.ua/og.jpg?a=1&amp;b=2">'), 'https://shop.ua/p/1')).toBe('https://cdn.x.ua/og.jpg?a=1&b=2')
    expect(extractProductImage(page('<img src="a.jpg">'), 'https://shop.ua/p/1')).toBeNull()
  })

  it('never fetches internal addresses, including after a redirect', async () => {
    expect(isPrivateAddress('10.0.0.5')).toBe(true)
    expect(isPrivateAddress('192.168.1.2')).toBe(true)
    expect(isPrivateAddress('127.0.0.1')).toBe(true)
    expect(isPrivateAddress('169.254.169.254')).toBe(true)
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true)
    expect(isPrivateAddress('93.184.216.34')).toBe(false)
    const resolver = async (host: string) => [{ address: host === 'evil.ua' ? '10.0.0.1' : '93.184.216.34' }]
    await expect(safeFetch('http://shop.ua/', 1000, signal, resolver)).rejects.toThrow('https')
    await expect(safeFetch('https://evil.ua/', 1000, signal, resolver)).rejects.toThrow('Внутрішня')
    await expect(safeFetch('https://localhost/', 1000, signal, resolver)).rejects.toThrow('Внутрішня')
    const redirecting = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.ua/x' } }))
    await expect(safeFetch('https://shop.ua/', 1000, signal, resolver, redirecting as any)).rejects.toThrow('Внутрішня')
    const big = vi.fn(async () => new Response('x'.repeat(2000), { status: 200, headers: { 'content-type': 'text/html' } }))
    await expect(safeFetch('https://shop.ua/', 1000, signal, resolver, big as any)).rejects.toThrow('Завеликий')
  })

  it('reads candidate pages only for requested products', () => {
    const text = 'Ось: [{"product_id":"a","page_urls":["https://s.ua/1","ftp://x"]},{"product_id":"zzz","page_url":"https://s.ua/2"}]'
    expect(Object.fromEntries(parseCandidatePages(text, new Set(['a', 'b'])))).toEqual({ a: ['https://s.ua/1'] })
    expect(parseCandidatePages('немає json', new Set(['a'])).size).toBe(0)
  })

  it('offers a photo only when the page has the exact article and a real image', async () => {
    const fetchPage = vi.fn(async (url: string) => url.endsWith('.jpg')
      ? { url, contentType: 'image/jpeg', bytes: JPEG }
      : url.includes('good')
        ? { url, contentType: 'text/html; charset=utf-8', bytes: Buffer.from(page('<h1>Щітка WA6684</h1>', '<meta property="og:image" content="https://s.ua/p.jpg">')) }
        : { url, contentType: 'text/html', bytes: Buffer.from(page('<h1>Щітка WA6685</h1>', '<meta property="og:image" content="https://s.ua/p.jpg">')) })
    const found = await verifyCandidate({ id: 'a', sku: 'WA6684' }, ['https://s.ua/wrong', 'https://s.ua/good'], signal, { fetchPage })
    expect(found).toMatchObject({ status: 'found', page_url: 'https://s.ua/good', mime_type: 'image/jpeg' })
    expect(Buffer.from(found.image_base64!, 'base64').equals(JPEG)).toBe(true)
    expect(await verifyCandidate({ id: 'a', sku: 'WA6684' }, ['https://s.ua/wrong'], signal, { fetchPage })).toMatchObject({ status: 'not_found' })
    expect(await verifyCandidate({ id: 'b', sku: '' }, ['https://s.ua/good'], signal, { fetchPage })).toMatchObject({ status: 'not_found' })
    expect(imageMime(Buffer.from('<html>'))).toBeNull()
  })
})
