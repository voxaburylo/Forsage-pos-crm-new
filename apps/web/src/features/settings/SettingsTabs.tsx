import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, Search } from 'lucide-react'

/**
 * 21.11.2026 (план зручності, «Налаштування»): була одна довга сторінка з ~20 блоків уперемішку.
 * Тепер — вкладки і пошук. Блоки лише ХОВАЮТЬСЯ (атрибут hidden), а не прибираються з форми:
 * поля, збереження і перевірки працюють як раніше.
 *
 * 23.11.2026 (план B4, слово власника: «з'явилося багато підвкладок… упорядкувати»): замість 8 вкладок — 6,
 * зібраних за змістом: усе про Telegram — в одній, усе про цей комп'ютер і копії — в одній, ціни й знижки — в одній.
 * У кожного блока — рядок «що це і коли потрібно». Рідкісне й небезпечне сховане за «Рідко потрібне».
 * Старі посилання й закладки (?tab=network тощо) ведуть у нові вкладки.
 */
export const SETTINGS_TABS = [
  { id: 'shop', label: 'Магазин' },
  { id: 'prices', label: 'Ціни і знижки' },
  { id: 'till', label: 'Каса і друк' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'pc', label: 'ПК і копії' },
  { id: 'ai', label: 'ШІ' },
  // 24.11.2026 (слово власника): постачальники, що дають товари за ключем API (Омега).
  { id: 'api', label: 'API-ключі' },
] as const
type VisibleTabId = (typeof SETTINGS_TABS)[number]['id']
/**
 * 'catalog' і 'audit' — блоки, що пішли з вкладок налаштувань: довідники товарів відкриваються з «Товарів»,
 * журнал аудиту — з «Аналітика → Контроль». Тут вони лишаються для пошуку й старих посилань.
 */
export type SettingsTabId = VisibleTabId | 'catalog' | 'audit'

/** Куди ведуть вкладки, яких більше немає. */
export const OLD_SETTINGS_TABS: Readonly<Record<string, SettingsTabId>> = {
  products: 'prices', sales: 'prices', notifications: 'telegram', network: 'pc', service: 'pc',
}
const HIDDEN_TABS: readonly SettingsTabId[] = ['catalog', 'audit']

export function resolveSettingsTab(value: string | null | undefined): SettingsTabId | null {
  if (!value) return null
  if (SETTINGS_TABS.some(tab => tab.id === value) || HIDDEN_TABS.includes(value as SettingsTabId)) return value as SettingsTabId
  return OLD_SETTINGS_TABS[value] ?? null
}

const STORAGE_KEY = 'forsage.settings.tab'

function initialTab(): SettingsTabId {
  try {
    const fromUrl = resolveSettingsTab(new URLSearchParams(window.location.search).get('tab'))
    if (fromUrl) return fromUrl
    const saved = resolveSettingsTab(window.localStorage.getItem(STORAGE_KEY))
    // Прихований блок відкривається лише за посиланням, а не «згадується» з минулого разу.
    if (saved && !HIDDEN_TABS.includes(saved)) return saved
  } catch { /* storage may be unavailable */ }
  return 'shop'
}

/**
 * Чи показувати блок: під час пошуку — за назвою/ключовими словами (і рідкісні теж), інакше — за вкладкою;
 * рідкісний блок — лише коли розгорнуто «Рідко потрібне».
 */
export function settingsSectionVisible(section: { tab: SettingsTabId; title: string; rare?: boolean }, active: SettingsTabId, query: string, showRare = false): boolean {
  const needle = query.trim().toLocaleLowerCase('uk-UA')
  if (needle) return section.title.toLocaleLowerCase('uk-UA').includes(needle)
  return section.tab === active && (!section.rare || showRare)
}

type State = {
  active: SettingsTabId; setActive: (tab: SettingsTabId) => void; query: string; setQuery: (query: string) => void
  showRare: boolean; setShowRare: (show: boolean) => void
}
const SettingsTabsContext = createContext<State | null>(null)

export function SettingsTabsProvider({ children }: { children: ReactNode }) {
  const [active, setActiveState] = useState<SettingsTabId>(initialTab)
  const [query, setQuery] = useState('')
  const [showRare, setShowRare] = useState(false)
  const value = useMemo<State>(() => ({
    active, query, setQuery, showRare, setShowRare,
    setActive: tab => {
      setActiveState(tab)
      setQuery('')
      setShowRare(false)
      try { window.localStorage.setItem(STORAGE_KEY, tab) } catch { /* optional */ }
    },
  }), [active, query, showRare])
  return <SettingsTabsContext.Provider value={value}>{children}</SettingsTabsContext.Provider>
}

function useSettingsTabs(): State {
  const state = useContext(SettingsTabsContext)
  if (!state) throw new Error('SettingsTabsProvider missing')
  return state
}

export function SettingsTabBar() {
  const { active, setActive, query, setQuery } = useSettingsTabs()
  return (
    <div className="sticky top-0 z-10 -mx-1 mb-4 space-y-2 bg-gray-50/95 px-1 pb-2 pt-1 backdrop-blur-sm">
      <div role="tablist" aria-label="Розділи налаштувань" className="flex flex-wrap gap-1.5">
        {SETTINGS_TABS.map(tab => (
          <button key={tab.id} type="button" role="tab" aria-selected={!query && active === tab.id}
            onClick={() => setActive(tab.id)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${!query && active === tab.id
              ? 'bg-gray-900 text-white' : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-100'}`}>
            {tab.label}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5">
        <Search size={14} className="text-gray-400" />
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Пошук налаштування: принтер, націнка, копія…"
          aria-label="Пошук налаштування" className="w-full bg-transparent text-sm outline-none" />
      </label>
    </div>
  )
}

/**
 * Блок налаштувань. title — назва й ключові слова для пошуку; hint — один рядок «що це і коли потрібно»;
 * rare — рідкісне чи небезпечне: показується лише після «Рідко потрібне» (або в пошуку).
 */
export function SettingsSection({ tab, title, hint, rare, children }: { tab: SettingsTabId; title: string; hint?: string; rare?: boolean; children: ReactNode }) {
  const { active, query, showRare } = useSettingsTabs()
  return (
    <div hidden={!settingsSectionVisible({ tab, title, rare }, active, query, showRare)} data-settings-tab={tab} data-settings-rare={rare ? 'true' : undefined}>
      {children}
      {hint && <p className="mt-1.5 px-1 text-xs text-gray-500 only:hidden" data-settings-hint>{hint}</p>}
    </div>
  )
}

/** Унизу вкладки: розгорнути рідкісні й небезпечні блоки цієї вкладки. */
export function SettingsRareToggle({ tabs }: { tabs: readonly SettingsTabId[] }) {
  const { active, query, showRare, setShowRare } = useSettingsTabs()
  if (query.trim() || !tabs.includes(active)) return null
  return (
    <button type="button" aria-expanded={showRare} onClick={() => setShowRare(!showRare)} data-settings-rare-toggle
      className="mt-6 flex w-full items-center justify-between rounded-lg border border-dashed border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50">
      <span>Рідко потрібне <span className="font-normal text-gray-500">— відновлення з копії, режим для старого ПК</span></span>
      <ChevronDown size={16} className={showRare ? 'rotate-180' : ''} aria-hidden="true" />
    </button>
  )
}

/** Кнопка «Зберегти» потрібна лише там, де є поля форми магазину. */
export function SettingsFormOnly({ tabs, children }: { tabs: readonly SettingsTabId[]; children: ReactNode }) {
  const { active, query } = useSettingsTabs()
  return <div hidden={!query.trim() && !tabs.includes(active)}>{children}</div>
}
