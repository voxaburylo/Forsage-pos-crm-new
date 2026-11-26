import { useEffect, useState } from 'react'
import { ExternalLink, PlugZap } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { SITE_URL, errorText, siteCall, useSiteUnseenCount } from './siteGateway'
import { SiteOrdersTab } from './SiteOrdersTab'
import { SiteCustomersTab, SiteHomeTab, SiteReviewsTab, SiteSettingsTab } from './SiteSimpleTabs'
import { BANNERS, CATEGORIES, PAGES, PROMOS, SiteCrudTab } from './SiteCrudTab'
import { SitePhotosTab } from './SiteProductsTab'
import { SiteAllProductsTab } from './SiteAllProductsTab'
import { SiteCatalogAccess } from './SiteCatalogAccess'
import { SiteAccessTab, useSiteSection } from './siteAccess'

/**
 * 26.11.2026, слово власника: «навести порядок у вкладках сайту — там товар, тут товар, там категорія; чітка зрозуміла
 * ієрархія: товари — усі категорії, уся робота з товарами; замовлення — уся робота із замовленнями».
 * Чотири розділи; у кожному — свої вкладки. Окремої «Товари на сайті» більше немає: фото й опис нашого товару —
 * у його картці («Товари → Усі товари», натиснути рядок).
 */
type TabId = 'all' | 'photos' | 'categories' | 'promos' | 'orders' | 'customers' | 'reviews' | 'home' | 'banners' | 'pages' | 'settings' | 'catalog' | 'access'
type SectionId = 'goods' | 'sales' | 'showcase' | 'setup'
interface SiteTab { id: TabId; label: string; ownerOnly?: boolean }
export const SITE_SECTIONS: ReadonlyArray<{ id: SectionId; label: string; tabs: readonly SiteTab[] }> = [
  // 26.11.2026, слово власника: «товари → категорії → товари в категорії, як на великих сайтах». Категорії — ліворуч у
  // «Товарах»; окрема вкладка «Категорії сайту» (розділи меню сайту) переїхала у «Вітрину» як «Меню каталогу».
  { id: 'goods', label: 'Товари', tabs: [
    { id: 'all', label: 'Товари за категоріями' }, { id: 'photos', label: 'Фото' }, { id: 'promos', label: 'Акції' },
  ] },
  { id: 'sales', label: 'Замовлення', tabs: [
    { id: 'orders', label: 'Замовлення' }, { id: 'customers', label: 'Покупці' }, { id: 'reviews', label: 'Відгуки' },
  ] },
  { id: 'showcase', label: 'Вітрина', tabs: [
    { id: 'home', label: 'Головна сторінка' }, { id: 'categories', label: 'Меню каталогу' }, { id: 'banners', label: 'Банери' }, { id: 'pages', label: 'Сторінки і статті' },
  ] },
  { id: 'setup', label: 'Налаштування', tabs: [
    { id: 'settings', label: 'Налаштування сайту' }, { id: 'catalog', label: 'Каталог для сайту', ownerOnly: true }, { id: 'access', label: 'Доступ', ownerOnly: true },
  ] },
]
export const SITE_TABS: readonly SiteTab[] = SITE_SECTIONS.flatMap(section => section.tabs)
const sectionOf = (tab: TabId) => SITE_SECTIONS.find(section => section.tabs.some(item => item.id === tab))!.id

/** Для чого кожна вкладка і що на ній робити — одним-двома реченнями (24.11.2026: власник: «не зрозуміло, що для чого»). */
export const SITE_TAB_INTRO: Record<TabId, string> = {
  all: 'Ліворуч — категорії (як на великих сайтах): виберіть категорію — праворуч її товари разом із вкладеними; «Усі товари» — усе підряд. Наші й від постачальників (Омега, GPL) — в одному списку. Натисніть наш товар — відкриється його сторінка для сайту: фото, опис, характеристики, «сховати»; назва, ціна й штрихкод — кнопкою «картка програми». Позначте кілька — масові дії: ціни, штрихкоди, видалення наших; ціна ±% і «прибрати з сайту» для товарів постачальників. Ціна ніколи не нижча за закупку.',
  photos: 'Фото багатьох товарів одразу: папка з файлами, названими артикулом чи штрихкодом, і фото, які сайт знайшов сам. Фото одного товару — у його картці у «Усіх товарах».',
  categories: 'Пункти меню каталогу на сайті (що бачить покупець угорі сайту). У кожному відмічаєте, які категорії програми в ньому показувати (кілька можна обʼєднати). Самі категорії товарів — у «Товарах» програми. Розділи шин веде сам сайт.',
  promos: 'Знижки на сайті: на все, на категорію, бренд чи окремі товари. Сайт сам покаже стару й нову ціну та «−N%». Ціну в програмі акція не змінює.',
  orders: 'Замовлення, які покупці оформили на сайті. Відкрийте замовлення, щоб змінити статус, вписати ТТН чи коментар — покупець побачить це у своєму кабінеті. «Створити замовлення в програмі» кладе його у звичайні «Замовлення», щоб зібрати й видати товар. Оплату приймає лише каса.',
  customers: 'Покупці, які зареєструвались на сайті. Це лише перегляд: з клієнтами програми вони не зливаються.',
  reviews: 'Відгуки покупців. Новий відгук не видно на сайті, доки ви не натиснете «Показати на сайті».',
  home: 'З яких блоків складається головна сторінка сайту і в якому порядку. Галочка — показувати блок, стрілки — пересунути.',
  banners: 'Великі картинки-слайди вгорі головної сторінки сайту: акція, сезон, новинка. Додайте банер, виберіть картинку й дати показу — програма сама обріже й стисне картинку.',
  pages: 'Тексти сайту: «Доставка», «Гарантія», «Про нас», «Контакти», «Питання» — їх можна лише редагувати; і статті — їх можна додавати й видаляти.',
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

const TAB_KEY = 'forsage.site.tab'
function storedTab(): TabId {
  try { const saved = localStorage.getItem(TAB_KEY); if (saved && SITE_TABS.some(item => item.id === saved)) return saved as TabId } catch { /* без памʼяті */ }
  return 'orders'
}

/**
 * «Сайт» (рішення власника 24.11.2026) — у власника (і в програмі, і у вебі з дому) та в тих, кому він дав доступ у вкладці «Доступ». Звідси керується сайт forsage-tires.com:
 * замовлення сайту, його клієнти, описи й фото товарів, категорії, банери, акції, головна, сторінки, відгуки, налаштування.
 * Сайт живе у своїй базі; кожна дія йде на сервер програми, а він — на шлюз сайту. Гроші приймає лише каса.
 */
export default function SitePage() {
  const [tab, setTabState] = useState<TabId>(storedTab)
  const setTab = (next: TabId) => { setTabState(next); try { localStorage.setItem(TAB_KEY, next) } catch { /* без памʼяті */ } }
  const unseen = useSiteUnseenCount(true)
  const [checking, setChecking] = useState(false)
  const [introOpen, setIntroOpen] = useState(false)
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
  const allowed = (item: SiteTab) => owner || !item.ownerOnly
  const current = owner || allowed(SITE_TABS.find(item => item.id === tab)!) ? tab : 'orders'
  const section: SectionId = sectionOf(current)
  const sectionTabs = SITE_SECTIONS.find(item => item.id === section)!.tabs.filter(allowed)
  const badge = (show: boolean) => show && unseen > 0 ? <span className="ml-1.5 rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-semibold text-white" data-site-unseen>{unseen}</span> : null
  return (
    <Layout title="Сайт" actions={<><Button size="sm" variant="secondary" icon={<PlugZap size={14} />} loading={checking} onClick={() => void ping()} data-site-ping className="max-sm:hidden">Перевірити звʼязок</Button>
      <Button size="sm" variant="secondary" icon={<ExternalLink size={14} />} onClick={() => window.open(SITE_URL, '_blank', 'noopener,noreferrer')} data-site-open>Відкрити сайт</Button></>}>
      <div className="w-full space-y-3" data-site-body>
        <p role="status" data-site-link={link.state} className={`rounded-lg border px-3 py-1.5 text-xs ${link.state === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : link.state === 'checking' ? 'border-gray-200 bg-white text-gray-600' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>{link.text}</p>
        {/* 26.11.2026, слово власника: «чотири колонки на всю ширину — некрасиво, багато порожнього місця». Розділи — компактний
            перемикач за шириною слів, вкладки розділу — поруч в одному рядку; на телефоні рядок гортається пальцем. */}
        <div className="flex flex-col gap-2 border-b border-gray-200 pb-2 lg:flex-row lg:items-center lg:gap-4">
          <div role="tablist" aria-label="Розділи сайту" className="inline-flex w-max max-w-full shrink-0 gap-0.5 overflow-x-auto rounded-lg bg-gray-100 p-0.5" data-site-sections>
            {SITE_SECTIONS.map(item => (
              <button key={item.id} type="button" role="tab" aria-selected={section === item.id} data-site-section={item.id}
                onClick={() => { if (section !== item.id) setTab(item.tabs.find(allowed)!.id) }}
                className={`shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${section === item.id ? 'bg-white font-semibold text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}>
                {item.label}{badge(item.id === 'sales')}
              </button>
            ))}
          </div>
          <div role="tablist" aria-label="Вкладки розділу" className="flex gap-1 max-lg:overflow-x-auto lg:flex-wrap" data-site-subtabs>
            {sectionTabs.map(item => (
              <button key={item.id} type="button" role="tab" aria-selected={current === item.id} data-site-tab={item.id} onClick={() => setTab(item.id)}
                className={`shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${current === item.id ? 'bg-yellow-100 font-semibold text-gray-900' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'}`}>
                {item.label}{badge(item.id === 'orders')}
              </button>
            ))}
          </div>
        </div>
        {/* Пояснення — дрібним рядком без рамки; повністю — натиснути. */}
        <button type="button" data-site-intro onClick={() => setIntroOpen(value => !value)} title={introOpen ? 'Згорнути' : 'Показати повністю'}
          className={`w-full text-left text-xs leading-relaxed text-gray-500 hover:text-gray-700 ${introOpen ? '' : 'line-clamp-1'}`}>{SITE_TAB_INTRO[current]}</button>
        {current === 'all' && <SiteAllProductsTab />}
        {current === 'photos' && <SitePhotosTab />}
        {current === 'categories' && <SiteCrudTab config={CATEGORIES} />}
        {current === 'promos' && <SiteCrudTab config={PROMOS} />}
        {current === 'orders' && <SiteOrdersTab />}
        {current === 'customers' && <SiteCustomersTab />}
        {current === 'reviews' && <SiteReviewsTab />}
        {current === 'home' && <SiteHomeTab />}
        {current === 'banners' && <SiteCrudTab config={BANNERS} />}
        {current === 'pages' && <SiteCrudTab config={PAGES} />}
        {current === 'settings' && <SiteSettingsTab />}
        {current === 'catalog' && owner && <SiteCatalogAccess />}
        {current === 'access' && owner && <SiteAccessTab />}
      </div>
    </Layout>
  )
}
