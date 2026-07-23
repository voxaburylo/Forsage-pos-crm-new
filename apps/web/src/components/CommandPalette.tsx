import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search, Package, Users, ClipboardList, Truck, ShoppingCart, Zap, Settings,
  Plus, FileText, BarChart2, CornerDownLeft,
} from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { productApi } from '@/features/products/productApi'
import { customerApi } from '@/features/customers/customerApi'
import { kopecksToHryvnia } from '@/types/product'

interface Item {
  id: string
  label: string
  sublabel?: string
  icon: React.ReactNode
  group: string
  run: () => void
}

interface StaticCmd {
  label: string
  icon: React.ReactNode
  to: string
  group: string
  roles?: string[]
  keywords?: string
}

const STATIC: StaticCmd[] = [
  // Перейти
  { label: 'Каса (POS)', icon: <Zap size={16} />, to: '/pos', group: 'Перейти', keywords: 'каса продаж чек' },
  { label: 'Товари', icon: <Package size={16} />, to: '/products', group: 'Перейти', keywords: 'склад товар' },
  { label: 'Клієнти', icon: <Users size={16} />, to: '/customers', group: 'Перейти' },
  { label: 'Замовлення', icon: <ClipboardList size={16} />, to: '/orders', group: 'Перейти', roles: ['owner', 'admin', 'manager'] },
  { label: 'Постачальники', icon: <Truck size={16} />, to: '/suppliers', group: 'Перейти', roles: ['owner', 'admin', 'manager', 'storekeeper'] },
  { label: 'Прихідні накладні', icon: <FileText size={16} />, to: '/suppliers/invoices', group: 'Перейти', keywords: 'прийом приход накладна' },
  { label: 'Збірка замовлень', icon: <ClipboardList size={16} />, to: '/inventory/picking', group: 'Перейти', roles: ['owner', 'admin', 'manager', 'storekeeper'], keywords: 'комплектація комірник видача' },
  { label: 'Складські операції', icon: <Package size={16} />, to: '/inventory', group: 'Перейти', roles: ['owner', 'admin', 'storekeeper'], keywords: 'ревізія списання переміщення резерв' },
  { label: 'Продажі та фінанси', icon: <ShoppingCart size={16} />, to: '/sales', group: 'Перейти' },
  { label: 'Дашборд', icon: <BarChart2 size={16} />, to: '/dashboard', group: 'Перейти', roles: ['owner', 'admin', 'manager'] },
  { label: 'Команда та ЗП', icon: <Users size={16} />, to: '/staff', group: 'Перейти', roles: ['owner', 'admin'] },
  { label: 'Налаштування', icon: <Settings size={16} />, to: '/settings', group: 'Перейти', roles: ['owner', 'admin'] },
  // Створити
  { label: 'Новий товар', icon: <Plus size={16} />, to: '/products/new', group: 'Створити', roles: ['owner', 'admin', 'manager', 'storekeeper'], keywords: 'додати товар' },
  { label: 'Нова накладна (прийом товару)', icon: <Plus size={16} />, to: '/suppliers/invoices/new', group: 'Створити', roles: ['owner', 'admin', 'manager', 'storekeeper'], keywords: 'прийом приход' },
  { label: 'Нове замовлення', icon: <Plus size={16} />, to: '/orders/new', group: 'Створити', roles: ['owner', 'admin', 'manager'] },
  { label: 'Новий клієнт', icon: <Plus size={16} />, to: '/customers/new', group: 'Створити' },
  { label: 'Новий постачальник', icon: <Plus size={16} />, to: '/suppliers/new', group: 'Створити', roles: ['owner', 'admin', 'manager'] },
]

export function CommandPalette() {
  const navigate = useNavigate()
  const session = useAuthStore((s) => s.session)
  const role = (session?.user?.app_metadata?.role as string) ?? 'cashier'

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [products, setProducts] = useState<Item[]>([])
  const [customers, setCustomers] = useState<Item[]>([])
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Гаряча клавіша ⌘K / Ctrl+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Скидання при відкритті
  useEffect(() => {
    if (open) { setQuery(''); setProducts([]); setCustomers([]); setSel(0); setTimeout(() => inputRef.current?.focus(), 50) }
  }, [open])

  const close = useCallback(() => setOpen(false), [])

  // Живий пошук товарів і клієнтів
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < 2) { setProducts([]); setCustomers([]); return }
    const t = setTimeout(async () => {
      try {
        const [pr, cu] = await Promise.all([
          productApi.search(q, 5).catch(() => ({ data: [] as any[] })),
          customerApi.list({ search: q, per_page: 5 }).catch(() => ({ data: [] as any[] } as any)),
        ])
        setProducts((pr.data ?? []).map((p: any) => ({
          id: 'p-' + p.id, group: 'Товари', icon: <Package size={16} className="text-gray-400" />,
          label: p.name, sublabel: `${p.sku ?? ''} · ${kopecksToHryvnia(p.retail_price)} ₴ · залишок ${p.qty_on_hand ?? 0}`,
          run: () => navigate(`/products/${p.id}`),
        })))
        setCustomers((cu.data ?? []).map((c: any) => ({
          id: 'c-' + c.id, group: 'Клієнти', icon: <Users size={16} className="text-gray-400" />,
          label: c.full_name || c.phone, sublabel: c.phone,
          run: () => navigate(`/customers/${c.id}`),
        })))
        setSel(0)
      } catch { /* ignore */ }
    }, 250)
    return () => clearTimeout(t)
  }, [query, open, navigate])

  if (!open || !session) return null

  const q = query.trim().toLowerCase()
  const staticItems: Item[] = STATIC
    .filter((c) => !c.roles || c.roles.includes(role))
    .filter((c) => !q || c.label.toLowerCase().includes(q) || (c.keywords ?? '').includes(q))
    .map((c) => ({ id: c.to + c.label, label: c.label, icon: c.icon, group: c.group, run: () => navigate(c.to) }))

  const flat: Item[] = [...staticItems, ...products, ...customers]
  const groups = ['Перейти', 'Створити', 'Товари', 'Клієнти']

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(flat.length - 1, s + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); const it = flat[sel]; if (it) { close(); it.run() } }
    else if (e.key === 'Escape') { close() }
  }

  let runningIndex = -1

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] px-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={close} />
      <div className="relative w-full max-w-xl bg-white rounded-2xl shadow-2xl overflow-hidden animate-slide-up flex flex-col max-h-[70vh]">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
          <Search size={18} className="text-gray-400 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Пошук: товар, клієнт, сторінка, дія…"
            className="flex-1 text-sm outline-none placeholder:text-gray-400"
          />
          <kbd className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded border border-gray-200">Esc</kbd>
        </div>
        <div className="overflow-y-auto flex-1 py-2">
          {flat.length === 0 ? (
            <p className="text-center text-sm text-gray-400 py-8">Нічого не знайдено</p>
          ) : (
            groups.map((g) => {
              const items = flat.filter((it) => it.group === g)
              if (items.length === 0) return null
              return (
                <div key={g} className="mb-1">
                  <p className="px-4 py-1 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">{g}</p>
                  {items.map((it) => {
                    runningIndex++
                    const idx = runningIndex
                    return (
                      <button
                        key={it.id}
                        onMouseEnter={() => setSel(idx)}
                        onClick={() => { close(); it.run() }}
                        className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ${idx === sel ? 'bg-yellow-50' : 'hover:bg-gray-50'}`}
                      >
                        <span className="shrink-0 text-gray-500">{it.icon}</span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm text-gray-800 truncate">{it.label}</span>
                          {it.sublabel && <span className="block text-xs text-gray-400 truncate">{it.sublabel}</span>}
                        </span>
                        {idx === sel && <CornerDownLeft size={14} className="text-gray-300 shrink-0" />}
                      </button>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>
        <div className="px-4 py-2 border-t border-gray-100 text-[11px] text-gray-400 flex items-center gap-3">
          <span>↑↓ вибір</span><span>↵ відкрити</span><span>⌘K / Ctrl+K</span>
        </div>
      </div>
    </div>
  )
}
