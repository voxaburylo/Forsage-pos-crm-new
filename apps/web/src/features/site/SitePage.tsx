import { useState } from 'react'
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

/**
 * «Сайт» (рішення власника 24.11.2026) — у власника (і в програмі, і у вебі з дому) та в тих, кому він дав доступ у вкладці «Доступ». Звідси керується сайт forsage-tires.com:
 * замовлення сайту, його клієнти, описи й фото товарів, категорії, банери, акції, головна, сторінки, відгуки, налаштування.
 * Сайт живе у своїй базі; кожна дія йде на сервер програми, а він — на шлюз сайту. Гроші приймає лише каса.
 */
export default function SitePage() {
  const [tab, setTab] = useState<TabId>('orders')
  const unseen = useSiteUnseenCount(true)
  const [checking, setChecking] = useState(false)
  // Перевірка звʼязку із сайтом: сайт називає себе, свій час і стан обміну каталогом.
  async function ping() {
    setChecking(true)
    try {
      const answer = await siteCall<{ site?: unknown; time?: unknown; catalog_sync?: unknown }>('ping')
      const sync = answer?.catalog_sync == null ? '' : ' · обмін каталогом: ' + (typeof answer.catalog_sync === 'string' ? answer.catalog_sync : JSON.stringify(answer.catalog_sync)).slice(0, 120)
      toast.success('Звʼязок із сайтом є' + (answer?.site ? ': ' + String(answer.site).slice(0, 60) : '') + sync)
    } catch (reason) { toast.error(errorText(reason, 'Немає звʼязку із сайтом')) } finally { setChecking(false) }
  }
  const { owner } = useSiteSection()
  const tabs = SITE_TABS.filter(item => owner || !('ownerOnly' in item && item.ownerOnly))
  return (
    <Layout title="Сайт" actions={<><Button size="sm" variant="secondary" icon={<PlugZap size={14} />} loading={checking} onClick={() => void ping()} data-site-ping>Перевірити звʼязок</Button>
      <Button size="sm" variant="secondary" icon={<ExternalLink size={14} />} onClick={() => window.open(SITE_URL, '_blank', 'noopener,noreferrer')} data-site-open>Відкрити сайт</Button></>}>
      <div className="mx-auto max-w-4xl space-y-4">
        <div role="tablist" aria-label="Розділи сайту" className="flex gap-1 overflow-x-auto border-b border-gray-200 pb-px">
          {tabs.map(item => (
            <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} data-site-tab={item.id} onClick={() => setTab(item.id)}
              className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === item.id ? 'border-accent font-semibold text-gray-900' : 'border-transparent text-gray-600 hover:text-gray-900'}`}>
              {item.label}
              {item.id === 'orders' && unseen > 0 && <span className="ml-1.5 rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-semibold text-white" data-site-unseen>{unseen}</span>}
            </button>
          ))}
        </div>
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
