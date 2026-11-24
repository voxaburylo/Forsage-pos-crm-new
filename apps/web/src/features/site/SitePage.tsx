import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button } from '@/components/ui'
import { SITE_URL, useSiteUnseenCount } from './siteGateway'
import { SiteOrdersTab } from './SiteOrdersTab'
import { SiteCustomersTab, SiteHomeTab, SiteReviewsTab, SiteSettingsTab } from './SiteSimpleTabs'
import { BANNERS, CATEGORIES, PAGES, PROMOS, SiteCrudTab } from './SiteCrudTab'
import { SiteProductsTab } from './SiteProductsTab'
import { SiteCatalogAccess } from './SiteCatalogAccess'

export const SITE_TABS = [
  { id: 'orders', label: 'Замовлення' }, { id: 'customers', label: 'Клієнти' }, { id: 'products', label: 'Товари на сайті' },
  { id: 'categories', label: 'Категорії' }, { id: 'banners', label: 'Банери' }, { id: 'promos', label: 'Акції' },
  { id: 'home', label: 'Головна сторінка' }, { id: 'pages', label: 'Сторінки і статті' }, { id: 'reviews', label: 'Відгуки' },
  { id: 'settings', label: 'Налаштування' }, { id: 'catalog', label: 'Каталог для сайту' },
] as const
type TabId = typeof SITE_TABS[number]['id']

/**
 * «Сайт» (рішення власника 24.11.2026) — лише в акаунті власника. Звідси керується сайт forsage-tires.com:
 * замовлення сайту, його клієнти, описи й фото товарів, категорії, банери, акції, головна, сторінки, відгуки, налаштування.
 * Сайт живе у своїй базі; кожна дія йде на сервер програми, а він — на шлюз сайту. Гроші приймає лише каса.
 */
export default function SitePage() {
  const [tab, setTab] = useState<TabId>('orders')
  const unseen = useSiteUnseenCount(true)
  return (
    <Layout title="Сайт" actions={<Button size="sm" variant="secondary" icon={<ExternalLink size={14} />} onClick={() => window.open(SITE_URL, '_blank', 'noopener,noreferrer')} data-site-open>Відкрити сайт</Button>}>
      <div className="mx-auto max-w-4xl space-y-4">
        <div role="tablist" aria-label="Розділи сайту" className="flex gap-1 overflow-x-auto border-b border-gray-200 pb-px">
          {SITE_TABS.map(item => (
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
        {tab === 'catalog' && <SiteCatalogAccess />}
      </div>
    </Layout>
  )
}
