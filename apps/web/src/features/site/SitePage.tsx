import { useEffect, useState } from 'react'
import { ExternalLink, PlugZap } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { SITE_URL, errorText, siteCall, useSiteUnseenCount } from './siteGateway'
import { SiteOrdersTab } from './SiteOrdersTab'
import { SiteCustomersTab, SiteHomeTab, SiteReviewsTab, SiteSettingsTab } from './SiteSimpleTabs'
import { BANNERS, CATEGORIES, PAGES, PROMOS, SiteCrudTab } from './SiteCrudTab'
import { SiteProductsTab } from './SiteProductsTab'
import { SiteCatalogAccess } from './SiteCatalogAccess'
import { SiteAccessTab, useSiteSection } from './siteAccess'

export const SITE_TABS = [
  { id: 'orders', label: 'Замовлення' }, { id: 'customers', label: 'Клієнти' }, { id: 'products', label: 'Товари на сайті' },
  { id: 'categories', label: 'Категорії' }, { id: 'banners', label: 'Банери' }, { id: 'promos', label: 'Акції' },
  { id: 'home', label: 'Головна сторінка' }, { id: 'pages', label: 'Сторінки і статті' }, { id: 'reviews', label: 'Відгуки' },
  { id: 'settings', label: 'Налаштування' }, { id: 'catalog', label: 'Каталог для сайту', ownerOnly: true }, { id: 'access', label: 'Доступ', ownerOnly: true },
] as const
type TabId = typeof SITE_TABS[number]['id']

/** Для чого кожна вкладка і що на ній робити — одним-двома реченнями (24.11.2026: власник: «не зрозуміло, що для чого»). */
export const SITE_TAB_INTRO: Record<TabId, string> = {
  orders: 'Замовлення, які покупці оформили на сайті. Відкрийте замовлення, щоб змінити статус, вписати ТТН чи коментар — покупець побачить це у своєму кабінеті. «Створити замовлення в програмі» кладе його у звичайні «Замовлення», щоб зібрати й видати товар. Оплату приймає лише каса.',
  customers: 'Покупці, які зареєструвались на сайті. Це лише перегляд: з клієнтами програми вони не зливаються.',
  products: 'Те, чого немає в програмі, але видно на сайті: опис, характеристики, фото, «сховати на сайті». Назву, ціну й залишок сайт бере з програми сам. Знайдіть товар за назвою чи артикулом і заповніть.',
  categories: 'Розділи каталогу на сайті. У кожному відмічаєте, які категорії програми в ньому показувати (кілька можна обʼєднати). Розділи шин веде сам сайт.',
  banners: 'Великі картинки-слайди вгорі головної сторінки сайту: акція, сезон, новинка. Додайте банер, виберіть картинку й дати показу — програма сама обріже й стисне картинку.',
  promos: 'Знижки на сайті: на все, на категорію, бренд чи окремі товари. Сайт сам покаже стару й нову ціну та «−N%». Ціну в програмі акція не змінює.',
  home: 'З яких блоків складається головна сторінка сайту і в якому порядку. Галочка — показувати блок, стрілки — пересунути.',
  pages: 'Тексти сайту: «Доставка», «Гарантія», «Про нас», «Контакти», «Питання» — їх можна лише редагувати; і статті — їх можна додавати й видаляти.',
  reviews: 'Відгуки покупців. Новий відгук не видно на сайті, доки ви не натиснете «Показати на сайті».',
  settings: 'Контакти, реквізити продавця й службові коди сайту (заголовок для пошуковиків, лічильники). Порожнє поле — сайт нічого не показує.',
  catalog: 'Запасний, безпечний спосіб для сайту читати каталог через сервер програми — без закупівельних цін. Потрібен лише якщо сайт не читає базу напряму.',
  access: 'Кому з працівників, крім вас, відкрито розділ «Сайт».',
}

interface SiteLink { state: 'checking' | 'ok' | 'stale' | 'down'; text: string }
/** Стан звʼязку із сайтом одним рядком: чи відповідає сайт і коли він востаннє забрав товари з програми. */
export function siteLinkText(answer: { site?: unknown; catalog_sync?: unknown } | null): SiteLink {
  if (!answer) return { state: 'down', text: 'Сайт не відповів. Перевірте інтернет і натисніть «Перевірити звʼязок».' }
  const sync = (answer.catalog_sync && typeof answer.catalog_sync === 'object' ? answer.catalog_sync : {}) as { minutes_since_ok?: unknown; stale?: unknown; last_error?: unknown }
  const minutes = Number(sync.minutes_since_ok)
  const when = Number.isFinite(minutes) ? (minutes < 1 ? 'щойно' : minutes < 90 ? `${Math.round(minutes)} хв тому` : `${Math.round(minutes / 60)} год тому`) : 'невідомо коли'
  const site = String(answer.site ?? 'сайт').slice(0, 60)
  if (sync.stale === true || sync.last_error) return { state: 'stale', text: `Сайт ${site} на звʼязку, але товари з програми забирав ${when}${sync.last_error ? ' — помилка: ' + String(sync.last_error).slice(0, 120) : ''}.` }
  return { state: 'ok', text: `Сайт ${site} на звʼязку. Товари, ціни й залишки з програми забрав ${when}.` }
}

/**
 * «Сайт» (рішення власника 24.11.2026) — у власника (і в програмі, і у вебі з дому) та в тих, кому він дав доступ у вкладці «Доступ». Звідси керується сайт forsage-tires.com:
 * замовлення сайту, його клієнти, описи й фото товарів, категорії, банери, акції, головна, сторінки, відгуки, налаштування.
 * Сайт живе у своїй базі; кожна дія йде на сервер програми, а він — на шлюз сайту. Гроші приймає лише каса.
 */
export default function SitePage() {
  const [tab, setTab] = useState<TabId>('orders')
  const unseen = useSiteUnseenCount(true)
  const [checking, setChecking] = useState(false)
  const [link, setLink] = useState<SiteLink>({ state: 'checking', text: 'Перевіряємо звʼязок із сайтом…' })
  // Перевірка звʼязку із сайтом: сайт називає себе, свій час і стан обміну каталогом.
  async function ping() {
    setChecking(true)
    try {
      const state = siteLinkText(await siteCall<{ site?: unknown; catalog_sync?: unknown }>('ping'))
      setLink(state)
      if (state.state === 'ok') toast.success(state.text); else toast.warning(state.text)
    } catch (reason) { const text = errorText(reason, 'Немає звʼязку із сайтом'); setLink({ state: 'down', text }); toast.error(text) } finally { setChecking(false) }
  }
  // Стан звʼязку видно одразу, без натискань.
  useEffect(() => {
    let alive = true
    siteCall<{ site?: unknown; catalog_sync?: unknown }>('ping').then(answer => { if (alive) setLink(siteLinkText(answer)) }, reason => { if (alive) setLink({ state: 'down', text: errorText(reason, 'Немає звʼязку із сайтом') }) })
    return () => { alive = false }
  }, [])
  const { owner } = useSiteSection()
  const tabs = SITE_TABS.filter(item => owner || !('ownerOnly' in item && item.ownerOnly))
  return (
    <Layout title="Сайт" actions={<><Button size="sm" variant="secondary" icon={<PlugZap size={14} />} loading={checking} onClick={() => void ping()} data-site-ping className="max-sm:hidden">Перевірити звʼязок</Button>
      <Button size="sm" variant="secondary" icon={<ExternalLink size={14} />} onClick={() => window.open(SITE_URL, '_blank', 'noopener,noreferrer')} data-site-open>Відкрити сайт</Button></>}>
      <div className="w-full space-y-4" data-site-body>
        <p role="status" data-site-link={link.state} className={`rounded-lg border px-4 py-2.5 text-sm ${link.state === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : link.state === 'checking' ? 'border-gray-200 bg-white text-gray-600' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>{link.text}</p>
        {/* На ПК вкладки переносяться в другий рядок, а не ховаються за повзунком; на телефоні — гортаються пальцем. */}
        <div role="tablist" aria-label="Розділи сайту" className="flex gap-1 border-b border-gray-200 pb-px max-md:overflow-x-auto md:flex-wrap">
          {tabs.map(item => (
            <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} data-site-tab={item.id} onClick={() => setTab(item.id)}
              className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === item.id ? 'border-accent font-semibold text-gray-900' : 'border-transparent text-gray-600 hover:text-gray-900'}`}>
              {item.label}
              {item.id === 'orders' && unseen > 0 && <span className="ml-1.5 rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-semibold text-white" data-site-unseen>{unseen}</span>}
            </button>
          ))}
        </div>
        <p data-site-intro className="rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm leading-relaxed text-gray-700">{SITE_TAB_INTRO[tab]}</p>
        {tab === 'orders' && <SiteOrdersTab />}
        {tab === 'customers' && <SiteCustomersTab />}
        {tab === 'products' && <SiteProductsTab />}
        {tab === 'categories' && <SiteCrudTab config={CATEGORIES} />}
        {tab === 'banners' && <SiteCrudTab config={BANNERS} />}
        {tab === 'promos' && <SiteCrudTab config={PROMOS} />}
        {tab === 'home' && <SiteHomeTab />}
        {tab === 'pages' && <SiteCrudTab config={PAGES} />}
        {tab === 'reviews' && <SiteReviewsTab />}
        {tab === 'settings' && <SiteSettingsTab />}
        {tab === 'catalog' && owner && <SiteCatalogAccess />}
        {tab === 'access' && owner && <SiteAccessTab />}
      </div>
    </Layout>
  )
}
