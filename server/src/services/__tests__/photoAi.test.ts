import { describe, expect, it, vi } from 'vitest'
vi.mock('../../db/pg.js', () => ({ pool: { query: vi.fn() } }))
vi.mock('../../db/supabase.js', () => ({ db: {} }))
import { buildQuery, isBlockedHost, parseSerperImages, pickCandidates, rejectReason, scoreCandidate, serperImages, PhotoAiLater, PhotoAiStop, type PhotoCandidate } from '../photoAi/photoSearch.js'
import { askVerdict, decidePhoto, parseVerdict, sameBrand, verdictPrompt, VERDICT_SYSTEM, type PhotoVerdict, type VerdictAsk } from '../photoAi/photoVerdict.js'
import { AppError } from '../../middleware/errorHandler.js'
import { compressPhoto, isAiPhotoUrl, shrinkForCheck, storePhoto, storedPath, thumbUrlOf } from '../photoAi/photoStore.js'
import { findPhotos } from '../photoAi/photoFinder.js'
import { DEFAULT_SETTINGS, keyHint, keysSchema, settingsSchema } from '../photoAi/photoAiConfig.js'
import { isNight } from '../photoAi/photoQueue.js'
import { publicPhoto, stopError } from '../photoAi/photoFinds.js'
import { isWriteAllowed } from '../../middleware/localFirstWriteGuard.js'

// 27.11.2026: «Пошук фото з ШІ» перенесено із сайту в програму. У даних навмисно є літера «s» і зворотні слеші не потрібні:
// регулярні вирази цих файлів уже раз губили «\s» (правило власника 26.11.2026).
const image = (over: Partial<PhotoCandidate> = {}): PhotoCandidate => ({
  imageUrl: 'https://shop.example/img/bosch-s4-005.jpg', title: 'Акумулятор Bosch S4 005 60Ah', link: 'https://shop.example/akb/bosch-s4-005',
  domain: 'shop.example', width: 1000, height: 1000, thumbnailUrl: 'https://encrypted-tbn0.gstatic.com/images?q=1', ...over })
const product = { id: '11111111-1111-4111-8111-111111111111', name: 'Акумулятор Bosch S4 005 60Ah (57235)', sku: '0 092 S40 050', brand: 'Bosch' }
const good: PhotoVerdict = { match: true, details_match: true, title_brand: 'Bosch', brand_on_photo: 'BOSCH', brand_same: true, white_background: true, no_extra_text: true, good_quality: true }
const rules = { require_white: true, forbid_text: true }

describe('photo search: the query, the filter and the score', () => {
  it('builds the query: digits in brackets go away, a slash becomes a space, a missing brand goes first', () => {
    expect(buildQuery('Свічка запалювання s 12/14  (57235)', 'NGK')).toBe('NGK Свічка запалювання s 12 14')
    expect(buildQuery('Олива Castrol Edge 5W-30 (4л)', 'castrol')).toBe('Олива Castrol Edge 5W-30 (4л)')
    expect(buildQuery('Фільтр masляний sss', null)).toBe('Фільтр masляний sss')
  })

  it('drops small, huge, oddly shaped pictures and pictures from marketplaces, social networks and photo stocks', () => {
    expect(rejectReason(image(), 600)).toBeNull()
    expect(rejectReason(image({ width: 599 }), 600)).toBe('замала')
    expect(rejectReason(image({ width: 3200, height: 3000 }), 600)).toBe('завелика')
    expect(rejectReason(image({ width: 1000, height: 1500 }), 600)).toBe('пропорції')
    expect(rejectReason(image({ width: 1500, height: 1000 }), 600)).toBe('пропорції')
    expect(rejectReason(image({ imageUrl: 'http://shop.example/a.jpg' }), 600)).toBe('адреса')
    for (const host of ['i.pinimg.com', 'www.pinterest.com', 'ae01.alicdn.com', 'www.olx.ua', 'scontent.fbcdn.net', 'vk.com', 'i.ok.ru', 'ok.ru', 'img.freepik.com', 'www.youtube.com'])
      expect(isBlockedHost(host), host).toBe(true)
    for (const host of ['vkusno.example', 'book.ru', 'shop.example', 'olxa.example']) expect(isBlockedHost(host), host).toBe(false)
    expect(rejectReason(image({ link: 'https://www.olx.ua/d/obyavlenie/akb' }), 600)).toBe('сайт')
  })

  it('scores: +3 a word with digits, +1 a plain word, +6 the article without spaces and dashes, +2 the brand, +1 from 800 px', () => {
    // Слова з цифрами: s4, 005, 60ah (3 × 3 = 9); звичайні: «акумулятор», bosch (2); бренд +2; розмір +1. Артикул 0092s40050 у тексті немає.
    expect(scoreCandidate(image(), product)).toBe(14)
    expect(scoreCandidate(image({ link: 'https://shop.example/akb/0092-S40-050' }), product)).toBe(20)
    expect(scoreCandidate(image({ width: 700, height: 700 }), product)).toBe(13)
    expect(scoreCandidate(image({ title: 'Щось інше', link: 'https://shop.example/x', imageUrl: 'https://shop.example/x.jpg' }), product)).toBe(1)
  })

  it('keeps the best ones, each picture once', () => {
    const picked = pickCandidates([image({ title: 'інше', link: 'https://a.example/1', imageUrl: 'https://a.example/1.jpg' }), image(), image(), image({ width: 300 })], product, 600, 8)
    expect(picked.map(item => item.score)).toEqual([14, 1])
  })

  it('reads a Serper answer for one query and for a batch', () => {
    const row = { title: 'T', imageUrl: 'https://a.example/1.jpg', imageWidth: 800, imageHeight: 700, thumbnailUrl: 'https://t.example/1', domain: 'A.example', link: 'https://a.example/p' }
    expect(parseSerperImages({ images: [row, { title: 'без адреси' }] })).toEqual([[{ imageUrl: row.imageUrl, title: 'T', link: row.link, domain: 'a.example', width: 800, height: 700, thumbnailUrl: row.thumbnailUrl }]])
    expect(parseSerperImages([{ images: [row] }, { images: [] }, {}]).map(list => list.length)).toEqual([1, 0, 0])
  })

  it('"no credits" and a bad key stop the queue; 429 and 5xx mean "later"', async () => {
    const answer = (status: number, body: string) => ({ fetch: (async () => new Response(body, { status })) as unknown as typeof fetch })
    await expect(serperImages('k', ['q'], answer(400, '{"message":"Not enough credits"}'))).rejects.toMatchObject({ reason: 'serper_credits' })
    await expect(serperImages('k', ['q'], answer(403, '{"message":"Unauthorized."}'))).rejects.toMatchObject({ reason: 'serper_key' })
    await expect(serperImages('k', ['q'], answer(429, ''))).rejects.toBeInstanceOf(PhotoAiLater)
    await expect(serperImages('k', ['q'], answer(503, ''))).rejects.toBeInstanceOf(PhotoAiLater)
    const sent: Array<{ url: string; init: RequestInit }> = []
    const ok = { fetch: (async (url: string, init: RequestInit) => { sent.push({ url, init }); return new Response(JSON.stringify([{ images: [] }, { images: [] }])) }) as unknown as typeof fetch }
    expect(await serperImages('secret', ['a s', 'b'], ok)).toEqual([[], []])
    expect(sent[0].url).toBe('https://google.serper.dev/images')
    expect((sent[0].init.headers as Record<string, string>)['X-API-KEY']).toBe('secret')
    expect(JSON.parse(String(sent[0].init.body))).toEqual([{ q: 'a s', num: 20, gl: 'ua', hl: 'uk' }, { q: 'b', num: 20, gl: 'ua', hl: 'uk' }])
  })
})

describe('photo check: what the model is asked and how the program decides', () => {
  it('asks about this very product', () => {
    const prompt = verdictPrompt(product)
    expect(prompt).toContain('«Акумулятор Bosch S4 005 60Ah (57235)»')
    expect(prompt).toContain('Бренд: Bosch. Артикул: 0 092 S40 050.')
    expect(prompt).toContain('Гетьман = Hetman')
    expect(verdictPrompt({ id: product.id, name: 'Щітка' })).toContain('Бренд: —. Артикул: —.')
  })

  it('reads the answer strictly: anything that is not true is "no"', () => {
    expect(parseVerdict('```json\n' + JSON.stringify(good) + '\n```')).toEqual(good)
    expect(parseVerdict('{"match":"true","details_match":true}')).toMatchObject({ match: false, details_match: true, good_quality: false, brand_on_photo: '' })
    expect(parseVerdict('не знаю')).toBeNull()
    expect(parseVerdict('{broken')).toBeNull()
  })

  it('accepts only the same product of the same brand, of good quality', () => {
    const text = 'акумулятор bosch s4 https://shop.example/bosch-s4'
    expect(decidePhoto(good, rules, product, text)).toEqual({ ok: true, reason: 'підходить' })
    expect(decidePhoto({ ...good, match: false }, rules, product, text).reason).toBe('на фото інший товар')
    expect(decidePhoto({ ...good, details_match: false }, rules, product, text).reason).toBe('характеристики на фото не збігаються з назвою')
    expect(decidePhoto({ ...good, good_quality: false }, rules, product, text).reason).toBe('нечітке фото або товар видно не повністю')
    expect(decidePhoto({ ...good, white_background: false }, rules, product, text).reason).toBe('фон не білий')
    expect(decidePhoto({ ...good, no_extra_text: false }, rules, product, text).reason).toBe('є водяний знак, ціна або напис магазину')
    expect(decidePhoto({ ...good, white_background: false, no_extra_text: false }, { require_white: false, forbid_text: false }, product, text).ok).toBe(true)
  })

  it('the brand: another brand in the same alphabet is a refusal even if the model says "same"; no brand on the photo needs it in the picture text', () => {
    expect(decidePhoto({ ...good, brand_on_photo: 'Varta', brand_same: true }, rules, product, 'bosch').reason).toBe('на фото інший бренд: Varta')
    expect(decidePhoto({ ...good, brand_on_photo: '' }, rules, product, 'акумулятор s4 60ah').reason).toBe('бренду не видно ні на фото, ні в описі картинки')
    expect(decidePhoto({ ...good, brand_on_photo: '' }, rules, product, 'https://shop.example/BOSCH-s4').ok).toBe(true)
    const hetman = { id: product.id, name: 'Ключ Гетьман 12 мм', brand: 'Гетьман' }
    expect(decidePhoto({ ...good, title_brand: 'Гетьман', brand_on_photo: 'Hetman', brand_same: true }, rules, hetman, 'x').ok).toBe(true)
    expect(decidePhoto({ ...good, title_brand: 'Гетьман', brand_on_photo: 'Stels', brand_same: false }, rules, hetman, 'x').reason).toBe('на фото інший бренд: Stels')
    // Бренду немає ні в картці, ні в назві — бренд не перевіряємо.
    expect(decidePhoto({ ...good, title_brand: '', brand_on_photo: 'NoName' }, rules, { id: product.id, name: 'Хомут 12 мм' }, 'x').ok).toBe(true)
    expect(sameBrand('Mann-Filter', 'MANN FILTER')).toBe(true)
    expect(sameBrand('Mann', 'Mann-Filter')).toBe(true)
    expect(sameBrand('Bosch', 'Varta')).toBe(false)
  })

  it('the assistant: a rate limit or an outage mean "later", a bad key or an empty account stop, one unreadable picture is just a refusal', async () => {
    const picture = { mime: 'image/jpeg', base64: 'AAAA' }
    const failing = (code: string, message: string) => (async () => { throw new AppError(code, message, 400) }) as VerdictAsk
    await expect(askVerdict(failing('AI_QUOTA_EXCEEDED', 'Досягнуто ліміту Anthropic або закінчився баланс.'), picture, 'p')).rejects.toBeInstanceOf(PhotoAiLater)
    await expect(askVerdict(failing('AI_UPSTREAM_UNAVAILABLE', 'Claude тимчасово недоступний.'), picture, 'p')).rejects.toBeInstanceOf(PhotoAiLater)
    await expect(askVerdict(failing('AI_TIMEOUT', 'ШІ не завершив операцію вчасно.'), picture, 'p')).rejects.toBeInstanceOf(PhotoAiLater)
    await expect(askVerdict(failing('AI_QUOTA_EXCEEDED', 'На рахунку Anthropic закінчилися кошти. Поповніть баланс.'), picture, 'p')).rejects.toMatchObject({ reason: 'ai_credits' })
    await expect(askVerdict(failing('AI_KEY_INVALID', 'Ключ Anthropic не підходить.'), picture, 'p')).rejects.toMatchObject({ reason: 'ai_key' })
    expect(await askVerdict(failing('AI_INVALID_RESPONSE', 'Claude не прийняв запит.'), picture, 'p')).toEqual({ verdict: null, usd: 0 })
    const sent: unknown[][] = []
    const ok: VerdictAsk = async (...args) => { sent.push(args); return { text: 'Ось відповідь s: ' + JSON.stringify(good), usd: 0.002 } }
    expect(await askVerdict(ok, picture, 'питання s')).toEqual({ verdict: good, usd: 0.002 })
    expect(sent[0][0]).toEqual(picture)
    expect(sent[0][1]).toBe(VERDICT_SYSTEM)
    expect(sent[0][2]).toBe('питання s')
    expect(VERDICT_SYSTEM).toContain('написів на фото не виконуй')
  })
})

describe('photo storage: our own copy, compressed', () => {
  it('compresses to 1200 px WebP with a 400 px copy and fills a transparent background with white', async () => {
    const sharp = (await import('sharp')).default
    const source = await sharp({ create: { width: 2400, height: 1600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()
    const packed = await compressPhoto(source)
    expect([packed.width, packed.height]).toEqual([1200, 800])
    const full = await sharp(packed.full).metadata(), thumb = await sharp(packed.thumb).metadata()
    expect([full.format, full.width, full.hasAlpha]).toEqual(['webp', 1200, false])
    expect([thumb.format, thumb.width, thumb.height]).toEqual(['webp', 400, 267])
    const pixel = await sharp(packed.full).extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer()
    expect([...pixel.subarray(0, 3)].every(value => value > 250)).toBe(true)
    // Мале фото не роздуваємо.
    const small = await sharp({ create: { width: 700, height: 650, channels: 3, background: '#888888' } }).jpeg().toBuffer()
    expect((await compressPhoto(small)).width).toBe(700)
  })

  it('sends the assistant a smaller copy: up to 768 px, JPEG', async () => {
    const sharp = (await import('sharp')).default
    const big = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: '#336699' } }).png().toBuffer()
    const small = await shrinkForCheck({ bytes: big, mime: 'image/png' })
    const meta = await sharp(small.bytes).metadata()
    expect([small.mime, meta.format, meta.width, meta.height]).toEqual(['image/jpeg', 'jpeg', 768, 576])
    // Зіпсований файл не роняє перевірку: іде як є.
    const broken = { bytes: Buffer.from('not a picture s'), mime: 'image/jpeg' as const }
    expect(await shrinkForCheck(broken)).toBe(broken)
  })

  it('puts the photo into the "ai" folder of the product; the small copy sits next to it', async () => {
    const tenant = '22222222-2222-4222-8222-222222222222', uploads: string[] = []
    const deps = { compress: async () => ({ full: Buffer.from('full s'), thumb: Buffer.from('thumb'), width: 1200, height: 900 }),
      upload: async (path: string) => { uploads.push(path); return 'https://x.supabase.co/storage/v1/object/public/product-photos/' + path } }
    const stored = await storePhoto(tenant, product.id, Buffer.from('x'), deps)
    expect(uploads[0]).toMatch(new RegExp('^ai/' + tenant + '/' + product.id + '/[0-9a-f]{20}[.]webp$'))
    expect(uploads[1]).toBe(uploads[0].replace('.webp', '_400.webp'))
    expect(stored.thumb_url).toBe(thumbUrlOf(stored.url))
    expect(isAiPhotoUrl(stored.url)).toBe(true)
    expect(isAiPhotoUrl('https://x.supabase.co/storage/v1/object/public/product-photos/' + product.id + '/own.jpg')).toBe(false)
    expect(storedPath(stored.url, tenant)).toBe(uploads[0])
    // Чужий магазин, чуже фото й хитрі шляхи прибирати не дозволено.
    expect(storedPath(stored.url, '33333333-3333-4333-8333-333333333333')).toBeNull()
    expect(storedPath('https://x.supabase.co/storage/v1/object/public/product-photos/ai/' + tenant + '/../secret.webp', tenant)).toBeNull()
    await expect(storePhoto('not-a-uuid', product.id, Buffer.from('x'), deps)).rejects.toThrow()
  })
})

describe('one product from the query to checked photos', () => {
  const keys = { serper: 's-key', ai: 'a-key', ai_model: 'claude-sonnet-5-5' }
  const list = (count: number) => Array.from({ length: count }, (_, index) => image({ imageUrl: `https://shop.example/img/bosch-s4-${index}.jpg` }))
  const deps = (verdicts: Array<PhotoVerdict | null | Error>) => {
    let turn = 0
    return { search: vi.fn(async () => [list(8)]), download: vi.fn(async () => ({ bytes: Buffer.alloc(4000), mime: 'image/jpeg' as const })),
      shrink: vi.fn(async (picture: { bytes: Buffer; mime: 'image/jpeg' | 'image/png' | 'image/webp' }) => picture),
      ask: vi.fn(async () => { const next = verdicts[Math.min(turn++, verdicts.length - 1)]; if (next instanceof Error) throw next; return { text: next ? JSON.stringify(next) : 'не знаю', usd: 0.002 } }) }
  }

  it('the bulk mode stops paying once enough photos are found; the card mode checks all eight', async () => {
    const calls = { serper: 0, ai: 0, usd: 0 }, bulk = deps([good])
    const found = await findPhotos(product, { ...DEFAULT_SETTINGS, photos_per_product: 2 }, keys, calls, { top: 6, need: 2 }, bulk)
    expect(found.filter(photo => photo.ok)).toHaveLength(3)
    expect(calls.serper).toBe(1)
    expect(calls.ai).toBe(3)
    expect(calls.usd).toBeCloseTo(0.006)
    expect(bulk.shrink).toHaveBeenCalledTimes(3)
    expect(bulk.search).toHaveBeenCalledWith('s-key', 'Акумулятор Bosch S4 005 60Ah', undefined)
    const cardCalls = { serper: 0, ai: 0, usd: 0 }
    const card = await findPhotos(product, DEFAULT_SETTINGS, keys, cardCalls, { top: 8, need: null }, deps([good, { ...good, match: false }]))
    expect(card).toHaveLength(8)
    expect(card.filter(photo => photo.ok)).toHaveLength(1)
    expect([cardCalls.serper, cardCalls.ai]).toEqual([1, 8])
    expect(card[1]).toMatchObject({ ok: false, reason: 'на фото інший товар' })
    expect(publicPhoto(card[0])).not.toHaveProperty('bytes')
  })

  it('a picture that did not download costs nothing; "busy" and "no credits" surface with what was spent', async () => {
    const calls = { serper: 0, ai: 0, usd: 0 }, broken = deps([good])
    broken.download.mockResolvedValue(null as never)
    const none = await findPhotos(product, DEFAULT_SETTINGS, keys, calls, { top: 6, need: 3 }, broken)
    expect(none.every(photo => !photo.ok)).toBe(true)
    expect(calls).toEqual({ serper: 1, ai: 0, usd: 0 })
    const busyCalls = { serper: 0, ai: 0, usd: 0 }
    await expect(findPhotos(product, DEFAULT_SETTINGS, keys, busyCalls, { top: 6, need: 3 }, deps([new PhotoAiLater('Помічник зайнятий')]))).rejects.toBeInstanceOf(PhotoAiLater)
    expect(busyCalls.serper).toBe(1)
    await expect(findPhotos(product, DEFAULT_SETTINGS, { ...keys, serper: null }, { serper: 0, ai: 0, usd: 0 }, { top: 6, need: 3 }, deps([good]))).rejects.toMatchObject({ reason: 'serper_key' })
    // Помічник вимкнений або без ключа — пошук навіть не починається (жодного платного запиту).
    const off = { serper: 0, ai: 0, usd: 0 }, noAsk = deps([good])
    await expect(findPhotos(product, DEFAULT_SETTINGS, { ...keys, ai: null }, off, { top: 6, need: 3 }, { search: noAsk.search, download: noAsk.download })).rejects.toMatchObject({ reason: 'ai_off' })
    expect(off).toEqual({ serper: 0, ai: 0, usd: 0 })
    expect(noAsk.search).not.toHaveBeenCalled()
    expect(stopError(new PhotoAiStop('serper_credits', 'кредити'))?.code).toBe('PHOTO_AI_NO_CREDITS')
    expect(stopError(new PhotoAiLater('зайнятий'))?.status).toBe(503)
    expect(stopError(new Error('інше'))).toBeNull()
  })
})

describe('settings, keys and the schedule', () => {
  it('defaults are the owner\'s: 3 photos, white background, no shop text, 600 px', () => {
    expect(DEFAULT_SETTINGS).toEqual({ photos_per_product: 3, require_white: true, forbid_text: true, min_size: 600, night_only: false })
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, photos_per_product: 6 }).success).toBe(false)
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, photos_per_product: 1, min_size: 800 }).success).toBe(true)
  })

  it('a key is never shown back, only its last four characters', () => {
    expect(keyHint('abcdefgh-s123')).toBe('…s123')
    expect(keyHint(null)).toBe('')
    expect(keysSchema.safeParse({ serper_key: 'abc s' }).success).toBe(false)
    expect(keysSchema.safeParse({ serper_key: '' }).success).toBe(true)
    expect(keysSchema.safeParse({ serper_key: 'abc_s-1.2' }).success).toBe(true)
  })

  it('night is 22:00–07:00 Kyiv time', () => {
    expect(isNight(new Date('2026-11-27T21:30:00+02:00'))).toBe(false)
    expect(isNight(new Date('2026-11-27T22:05:00+02:00'))).toBe(true)
    expect(isNight(new Date('2026-11-28T00:10:00+02:00'))).toBe(true)
    expect(isNight(new Date('2026-11-28T06:59:00+02:00'))).toBe(true)
    expect(isNight(new Date('2026-11-28T07:00:00+02:00'))).toBe(false)
  })

  it('the web may use the feature: its data lives only on the server', () => {
    const request = (method: string, path: string) => ({ method, path, get: () => undefined }) as never
    expect(isWriteAllowed(request('POST', '/api/v1/ai/photo-ai/search'))).toBe(true)
    expect(isWriteAllowed(request('POST', '/api/v1/ai/photo-ai/keys'))).toBe(true)
    expect(isWriteAllowed(request('POST', '/api/v1/ai/photo-aix'))).toBe(false)
  })
})
