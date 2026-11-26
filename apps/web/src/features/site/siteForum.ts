import { compressWebp, putImage, siteCall } from './siteGateway'

/**
 * Форум сайту forsage-tires.com у програмі (27.11.2026, «Доповнення 5» контракту сайту). Програма пише на форум від імені
 * магазину («Форсаж (магазин)»). Кожна зміна йде через сервер програми й шлюз сайту і записується в журнал аудиту.
 */
export interface ForumSection { id: string | number; parent_id?: string | number | null; slug: string; name: string; description?: string | null; sort_order?: number | null }
export interface ForumTopicRow {
  id: string | number; title: string; section?: string | null; author_name?: string | null; is_shop?: boolean; is_pinned?: boolean; is_locked?: boolean; is_hidden?: boolean
  replies_count?: number; views?: number; last_reply_at?: string | null; url?: string | null
}
export interface ForumPost { id: string | number; parent_id?: string | number | null; author_name?: string | null; is_shop?: boolean; body: string; images?: string[] | null; is_hidden?: boolean; created_at?: string | null }
export interface ForumTopic extends ForumTopicRow { body?: string | null; images?: string[] | null; posts?: ForumPost[] | null; created_at?: string | null }

export const FORUM_PHOTO = { side: 1600, quality: 0.8, bytes: 350 * 1024 }
export const FORUM_LIMITS = { title: 200, body: 20_000, photos: 8 } as const

/** Фото для теми чи відповіді: стискаємо до ~1600 px у WebP, вантажимо на адресу сайту, повертаємо публічні адреси. */
export async function uploadForumPhotos(files: Blob[], onStep?: (done: number) => void): Promise<string[]> {
  const images = files.slice(0, FORUM_LIMITS.photos)
  if (!images.length) return []
  const slots = await siteCall<Array<{ upload_url: string; public_url: string }>>('forum.photos.upload_url', { count: images.length, ext: 'webp' })
  if (!Array.isArray(slots) || slots.length < images.length) throw new Error('Сайт видав менше адрес для фото, ніж потрібно')
  const urls: string[] = []
  for (const [index, file] of images.entries()) {
    await putImage(slots[index].upload_url, await compressWebp(file, FORUM_PHOTO))
    urls.push(slots[index].public_url)
    onStep?.(index + 1)
  }
  return urls
}

/** Перевірка тексту перед відправкою: порожнє й завелике не шлемо на сайт. */
export function forumTextProblem(kind: 'topic' | 'reply', title: string, body: string, section?: string): string {
  if (kind === 'topic' && !section) return 'Виберіть розділ форуму'
  if (kind === 'topic' && title.trim().length < 8) return 'Заголовок теми — хоча б 8 знаків: так, як людина шукала б у Google'
  if (title.length > FORUM_LIMITS.title) return 'Заголовок задовгий'
  if (body.trim().length < (kind === 'topic' ? 40 : 2)) return kind === 'topic' ? 'Напишіть текст теми — хоча б кілька речень' : 'Напишіть відповідь'
  if (body.length > FORUM_LIMITS.body) return 'Текст задовгий'
  return ''
}

export const when = (iso?: string | null) => {
  const time = iso ? Date.parse(iso) : NaN
  return Number.isFinite(time) ? new Date(time).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
}

/** Статистика форуму — сайт віддає числа й списки з різними назвами полів; показуємо числа, що є, людськими словами. */
const STAT_LABELS: Array<[RegExp, string]> = [
  [/^(new_)?topics?(_count)?$/i, 'нових тем'], [/^(new_)?(replies|posts)(_count)?$/i, 'відповідей'], [/^(new_)?(customers|buyers|users)(_count)?$/i, 'нових покупців'],
  [/^(authors|writers)(_count)?$/i, 'хто писав'], [/^views?(_count)?$/i, 'переглядів'],
]
export function forumStatsLine(stats: unknown, days: number): string {
  if (!stats || typeof stats !== 'object') return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(stats as Record<string, unknown>)) {
    const label = STAT_LABELS.find(([pattern]) => pattern.test(key))?.[1]
    const number = typeof value === 'number' ? value : Array.isArray(value) && /authors|writers/i.test(key) ? value.length : null
    if (label && number !== null && !parts.some(part => part.endsWith(label))) parts.push(`${number.toLocaleString('uk-UA')} ${label}`)
  }
  return parts.length ? `За ${days} днів: ${parts.join(' · ')}.` : ''
}
