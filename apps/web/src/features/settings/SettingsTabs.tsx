import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'

/**
 * 21.11.2026 (план зручності, «Налаштування»): була одна довга сторінка з ~20 блоків уперемішку.
 * Тепер — вкладки і пошук. Блоки лише ХОВАЮТЬСЯ (атрибут hidden), а не прибираються з форми:
 * поля, збереження і перевірки працюють як раніше.
 */
export const SETTINGS_TABS = [
  { id: 'shop', label: 'Магазин' },
  { id: 'products', label: 'Товари' },
  { id: 'sales', label: 'Продаж' },
  { id: 'till', label: 'Каса і друк' },
  { id: 'notifications', label: 'Повідомлення' },
  { id: 'network', label: 'Мережа і копії' },
  { id: 'ai', label: 'ШІ' },
  { id: 'service', label: 'Обслуговування' },
] as const
export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id']

const STORAGE_KEY = 'forsage.settings.tab'

function initialTab(): SettingsTabId {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('tab')
    const saved = fromUrl ?? window.localStorage.getItem(STORAGE_KEY)
    if (SETTINGS_TABS.some(tab => tab.id === saved)) return saved as SettingsTabId
  } catch { /* storage may be unavailable */ }
  return 'shop'
}

/** Чи показувати блок: під час пошуку — за назвою/ключовими словами, інакше — за вкладкою. */
export function settingsSectionVisible(section: { tab: SettingsTabId; title: string }, active: SettingsTabId, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase('uk-UA')
  if (needle) return section.title.toLocaleLowerCase('uk-UA').includes(needle)
  return section.tab === active
}

type State = { active: SettingsTabId; setActive: (tab: SettingsTabId) => void; query: string; setQuery: (query: string) => void }
const SettingsTabsContext = createContext<State | null>(null)

export function SettingsTabsProvider({ children }: { children: ReactNode }) {
  const [active, setActiveState] = useState<SettingsTabId>(initialTab)
  const [query, setQuery] = useState('')
  const value = useMemo<State>(() => ({
    active, query, setQuery,
    setActive: tab => {
      setActiveState(tab)
      setQuery('')
      try { window.localStorage.setItem(STORAGE_KEY, tab) } catch { /* optional */ }
    },
  }), [active, query])
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

/** Блок налаштувань. title — назва й ключові слова для пошуку. */
export function SettingsSection({ tab, title, children }: { tab: SettingsTabId; title: string; children: ReactNode }) {
  const { active, query } = useSettingsTabs()
  return <div hidden={!settingsSectionVisible({ tab, title }, active, query)} data-settings-tab={tab}>{children}</div>
}

/** Кнопка «Зберегти» потрібна лише там, де є поля форми магазину. */
export function SettingsFormOnly({ tabs, children }: { tabs: readonly SettingsTabId[]; children: ReactNode }) {
  const { active, query } = useSettingsTabs()
  return <div hidden={!query.trim() && !tabs.includes(active)}>{children}</div>
}
