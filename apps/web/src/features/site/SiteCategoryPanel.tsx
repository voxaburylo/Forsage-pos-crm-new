import { useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, FolderOpen, LayoutGrid, Search } from 'lucide-react'
import { buildCategoryTree, countFor, filterTree, type CatalogCategoryTree, type CatalogSource, type CategoryNode } from './siteCategoryTree'

/** Вибір у лівій колонці: '' — усі товари, 'none' — без категорії, інакше id категорії. */
export type CategoryChoice = string

/**
 * Ліва колонка «Сайт → Товари»: «Усі товари», дерево категорій програми з кількістю товарів, «Без категорії».
 * На телефоні — кнопка «Категорія: …», що розгортає той самий список.
 */
export function SiteCategoryPanel({ tree, source, value, onChange }: {
  tree: CatalogCategoryTree | null; source: CatalogSource; value: CategoryChoice; onChange: (next: CategoryChoice) => void
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [find, setFind] = useState('')
  const [phoneOpen, setPhoneOpen] = useState(false)
  const nodes = useMemo(() => tree ? buildCategoryTree(tree.categories, source) : [], [tree, source])
  const shown = useMemo(() => filterTree(nodes, find), [nodes, find])
  const none = tree ? countFor(tree.none, source) : 0
  const all = nodes.reduce((sum, node) => sum + node.total, 0) + none
  const currentName = value === '' ? 'Усі товари' : value === 'none' ? 'Без категорії' : tree?.categories.find(row => row.id === value)?.name ?? 'Категорія'
  const pick = (next: CategoryChoice) => { onChange(next); setPhoneOpen(false) }
  const toggle = (id: string) => setOpen(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })

  const row = (key: string, label: string, count: number, active: boolean, onClick: () => void, depth = 0, icon?: ReactNode, expander?: ReactNode) => (
    <li key={key}>
      <div className={`flex items-center rounded-lg ${active ? 'bg-yellow-100 font-semibold text-gray-900' : 'text-gray-700 hover:bg-gray-100'}`} style={{ paddingLeft: depth * 14 }}>
        {expander ?? <span className="w-6 shrink-0" />}
        <button type="button" onClick={onClick} data-site-category={key} aria-current={active ? 'true' : undefined}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-2 text-left text-sm">
          {icon}<span className="min-w-0 flex-1 truncate">{label}</span>
          <span className="shrink-0 text-xs tabular-nums text-gray-400">{count.toLocaleString('uk-UA')}</span>
        </button>
      </div>
    </li>
  )
  const branch = (node: CategoryNode, depth: number): ReactNode[] => {
    const expanded = open.has(node.id) || Boolean(find.trim())
    const expander = node.children.length
      ? <button type="button" aria-label={expanded ? 'Згорнути' : 'Розгорнути'} onClick={() => toggle(node.id)} className="flex w-6 shrink-0 justify-center text-gray-400 hover:text-gray-700">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
      : undefined
    return [row(node.id, node.name, node.total, value === node.id, () => pick(node.id), depth, undefined, expander),
      ...(expanded ? node.children.flatMap(child => branch(child, depth + 1)) : [])]
  }

  const list = (
    <div className="space-y-2">
      {nodes.length > 12 && (
        <label className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1.5">
          <Search size={13} className="text-gray-400" aria-hidden="true" />
          <input value={find} onChange={event => setFind(event.target.value)} placeholder="Знайти категорію" aria-label="Знайти категорію" className="w-full bg-transparent text-sm outline-none" />
        </label>
      )}
      <ul className="space-y-px" data-site-category-list>
        {row('', 'Усі товари', all, value === '', () => pick(''), 0, <LayoutGrid size={14} className="shrink-0 text-gray-400" />)}
        {!tree && <li className="px-2 py-2 text-xs text-gray-400">Завантажуємо категорії…</li>}
        {shown.flatMap(node => branch(node, 0))}
        {none > 0 && row('none', 'Без категорії', none, value === 'none', () => pick('none'), 0, <FolderOpen size={14} className="shrink-0 text-gray-400" />)}
      </ul>
    </div>
  )

  return (
    <>
      <div className="md:hidden">
        <button type="button" onClick={() => setPhoneOpen(current => !current)} aria-expanded={phoneOpen} data-site-category-toggle
          className="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm">
          <span className="truncate">Категорія: <b>{currentName}</b></span>{phoneOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        {phoneOpen && <div className="mt-1 max-h-[60vh] overflow-y-auto rounded-lg border border-gray-200 bg-white p-1.5">{list}</div>}
      </div>
      <aside className="hidden w-64 shrink-0 md:block" aria-label="Категорії товарів">
        <div className="sticky top-2 max-h-[calc(100vh-7rem)] overflow-y-auto rounded-xl border border-gray-200 bg-white p-1.5">{list}</div>
      </aside>
    </>
  )
}
