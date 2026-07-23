import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, Users, Copy, Phone, Edit, Trash2, Search, Download, X as XIcon, Car, Loader2, ArrowUp, Barcode } from 'lucide-react'
import { customerApi } from './customerApi'
import { customerGroupsApi, type CustomerGroup } from './customerGroupsApi'
import { QuickCustomerEditModal } from './QuickCustomerEditModal'
import type { Customer } from '@/types/customer'
import { Layout } from '@/components/Layout'
import { Button, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import { listCustomersOffline } from '@/lib/offlineDB'

const PER_PAGE = 50

export default function CustomersPage() {
  const navigate = useNavigate()
  const session = useAuthStore((state) => state.session)
  const offlineMode = useAuthStore((state) => state.offlineMode)
  const role = (session?.user.app_metadata?.role as string | undefined) ?? 'cashier'
  const scopeKey = session?.user.id ?? ''
  const canManageCustomers = ['owner', 'admin', 'manager'].includes(role)
  const canDeleteCustomers = ['owner', 'admin'].includes(role)
  const [sp] = useSearchParams()

  const [customers, setCustomers] = useState<Customer[]>([])
  const [total, setTotal]         = useState(0)
  const [page, setPage]           = useState(1)
  const [hasMore, setHasMore]     = useState(false)
  const [loading, setLoading]     = useState(false)     // перше завантаження / зміна фільтра
  const [loadingMore, setLoadingMore] = useState(false) // дозавантаження при скролі

  const [search, setSearch]       = useState('')
  const [hasDebt, setHasDebt]     = useState(sp.get('has_debt') === 'true')
  const [groups, setGroups]       = useState<CustomerGroup[]>([])
  const [quickEditCustomer, setQuickEditCustomer] = useState<Customer | null>(null)
  const [activeGroup, setActiveGroup] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkGroupId, setBulkGroupId] = useState('')
  const [bulkOperating, setBulkOperating] = useState(false)
  const [showScrollTop, setShowScrollTop] = useState(false)
  const [editBarcodeId, setEditBarcodeId] = useState<string | null>(null)
  const [barcodeDraft, setBarcodeDraft] = useState('')
  const [savingBarcode, setSavingBarcode] = useState(false)
  const cancelBarcodeEditRef = useRef(false)

  const sentinelRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)

  useEffect(() => {
    const scroller = document.getElementById('app-main-scroll')
    if (!scroller) return
    const handleScroll = () => setShowScrollTop(scroller.scrollTop > 500)
    handleScroll()
    scroller.addEventListener('scroll', handleScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', handleScroll)
  }, [])

  function scrollToTop() {
    document.getElementById('app-main-scroll')?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  useEffect(() => {
    if (offlineMode) { setGroups([]); return }
    customerGroupsApi.list().then((res) => {
      const seen = new Set<string>()
      const unique = (res.data ?? []).filter((g) => {
        if (seen.has(g.name)) return false
        seen.add(g.name)
        return true
      })
      setGroups(unique)
    }).catch(() => {})
  }, [offlineMode])

  // Завантаження сторінки: reset=true — новий фільтр (замінюємо), інакше — дозавантаження (додаємо)
  const fetchPage = useCallback(async (pageToLoad: number, reset: boolean) => {
    if (loadingRef.current) return
    loadingRef.current = true
    if (reset) setLoading(true); else setLoadingMore(true)
    const local = !activeGroup ? await listCustomersOffline({
      search,
      hasDebt,
      page: pageToLoad,
      perPage: PER_PAGE,
      scopeKey,
    }).catch(() => null) : null
    if (local && (local.data.length > 0 || local.pagination.total > 0)) {
      setTotal(local.pagination.total)
      setHasMore(pageToLoad < local.pagination.total_pages)
      setPage(pageToLoad)
      setCustomers((prev) => reset ? local.data : [...prev, ...local.data.filter(
        (candidate) => !prev.some((existing) => existing.id === candidate.id),
      )])
      if (reset) setLoading(false); else setLoadingMore(false)
    }
    try {
      const data = await customerApi.list({
        search:   search || undefined,
        has_debt: hasDebt ? 'true' : undefined,
        sort:     hasDebt ? 'debt' : undefined,
        group_id: activeGroup ?? undefined,
        page:     pageToLoad,
        per_page: PER_PAGE,
      })
      setTotal(data.pagination.total)
      setHasMore(pageToLoad < data.pagination.total_pages)
      setPage(pageToLoad)
      setCustomers((prev) => reset ? data.data : [
        ...prev.filter((existing) => !data.data.some((candidate) => candidate.id === existing.id)),
        ...data.data,
      ])
    } catch (e) {
      if (!local?.data.length) toast.error(e instanceof Error ? e.message : 'Помилка завантаження')
    } finally {
      loadingRef.current = false
      setLoading(false)
      setLoadingMore(false)
    }
  }, [search, hasDebt, activeGroup, scopeKey])

  useEffect(() => {
    const refreshFromLocalPull = () => { void fetchPage(1, true) }
    window.addEventListener('forsage:desktop-sync-completed', refreshFromLocalPull)
    return () => window.removeEventListener('forsage:desktop-sync-completed', refreshFromLocalPull)
  }, [fetchPage])
  // Скидання при зміні фільтрів/пошуку (з невеликим debounce для пошуку)
  useEffect(() => {
    setSelectedIds(new Set())
    const t = setTimeout(() => { fetchPage(1, true) }, 250)
    return () => clearTimeout(t)
  }, [search, hasDebt, activeGroup, fetchPage])

  // Нескінченний скрол — довантажуємо, коли sentinel зʼявляється у видимій зоні
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasMore && !loadingRef.current) {
        fetchPage(page + 1, false)
      }
    }, { rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, page, fetchPage])

  function copyToClipboard(text: string | null | undefined, label: string) {
    if (!text) return
    navigator.clipboard.writeText(text).then(() => {
      toast.success(`Скопійовано: ${label}`)
    }).catch(() => {})
  }

  function startBarcodeEdit(customer: Customer) {
    cancelBarcodeEditRef.current = false
    setEditBarcodeId(customer.id)
    setBarcodeDraft(customer.card_barcode ?? '')
  }

  async function saveBarcode(customer: Customer) {
    if (cancelBarcodeEditRef.current) {
      cancelBarcodeEditRef.current = false
      return
    }
    const value = barcodeDraft.trim()
    if ((customer.card_barcode ?? '') === value) {
      setEditBarcodeId(null)
      return
    }
    setSavingBarcode(true)
    try {
      const { data } = await customerApi.update(customer.id, { card_barcode: value || null })
      setCustomers((current) => current.map((item) => item.id === customer.id ? { ...item, card_barcode: data.card_barcode } : item))
      setEditBarcodeId(null)
      toast.success(value ? 'Штрихкод картки збережено' : 'Штрихкод картки видалено')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося зберегти штрихкод')
    } finally {
      setSavingBarcode(false)
    }
  }

  async function handleDelete(c: Customer) {
    const name = c.full_name ?? c.phone ?? 'без імені'
    if (!confirm(`Видалити клієнта "${name}"?`)) return
    try {
      await customerApi.delete(c.id)
      toast.success('Клієнта видалено')
      setCustomers((prev) => prev.filter((x) => x.id !== c.id))
      setTotal((t) => Math.max(0, t - 1))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (selectedIds.size === customers.length) setSelectedIds(new Set())
    else setSelectedIds(new Set(customers.map((c) => c.id)))
  }

  async function handleBulkAddToGroup() {
    if (!bulkGroupId || selectedIds.size === 0) return
    setBulkOperating(true)
    try {
      await customerGroupsApi.addMembers(bulkGroupId, Array.from(selectedIds))
      toast.success(`Додано ${selectedIds.size} клієнтів у групу`)
      setSelectedIds(new Set())
      setBulkGroupId('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    } finally {
      setBulkOperating(false)
    }
  }

  function handleBulkExportCSV() {
    if (selectedIds.size === 0) return
    const chosen = customers.filter((c) => selectedIds.has(c.id))
    const rows = [
      ['Телефон', 'Ім\'я', 'Штрихкод картки', 'VIN', 'Email', 'Борг,грн', 'Бонусів,грн', 'VIP', 'Ризик', 'Теги'].join(','),
      ...chosen.map((c) =>
        [
          c.phone ?? '',
          `"${(c.full_name ?? '').replace(/"/g, '""')}"`,
          c.card_barcode ?? '',
          c.primary_vin ?? '',
          c.email ?? '',
          (c.debt_balance / 100).toFixed(2),
          (c.bonus_balance / 100).toFixed(2),
          c.vip_level,
          c.risk_profile,
          `"${c.tags.join('; ')}"`,
        ].join(',')
      ),
    ].join('\n')
    const blob = new Blob([rows], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `customers_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success(`Експортовано ${chosen.length} клієнтів`)
  }

  const groupCount = (g: CustomerGroup): number => g.members?.[0]?.count ?? 0
  const isAllSelected = customers.length > 0 && selectedIds.size === customers.length

  return (
    <Layout
      title={`Клієнти${total ? ` (${total})` : ''}`}
      actions={
        <Button icon={<Plus size={16} />} onClick={() => navigate('/customers/new')}>
          Новий клієнт
        </Button>
      }
    >
      {/* Групи (таби) */}
      {groups.length > 0 && (
        <div className="flex gap-1.5 mb-4 overflow-x-auto pb-1 shrink-0">
          <button
            onClick={() => setActiveGroup(null)}
            className={`shrink-0 px-3.5 py-2 rounded-lg text-xs font-medium transition-colors ${
              activeGroup === null ? 'bg-yellow-400 text-black' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            👥 Всі
          </button>
          {groups.map((g) => (
            <button key={g.id}
              onClick={() => setActiveGroup(g.id)}
              className={`shrink-0 px-3.5 py-2 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
                activeGroup === g.id ? 'bg-yellow-400 text-black' : 'text-gray-600 hover:bg-gray-200'
              }`}
              style={activeGroup !== g.id ? { backgroundColor: g.color + '15', color: g.color } : {}}
            >
              {g.name}
              <span className="text-[10px] opacity-60">({groupCount(g)})</span>
            </button>
          ))}
        </div>
      )}

      {/* Пошук + фільтр */}
      <div className="flex gap-3 mb-4">
        <div className="relative flex-1 min-w-0">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Телефон, ім’я, VIN або штрихкод картки..."
            className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400/50"
          />
        </div>
        <Button variant={hasDebt ? 'primary' : 'secondary'} onClick={() => setHasDebt(!hasDebt)} size="sm">
          {hasDebt ? '🔴 З боргом' : 'Борг'}
        </Button>
      </div>

      {/* Список клієнтів */}
      <Card padding="none">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-gray-400 text-sm">Завантаження...</div>
        ) : customers.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-gray-400">
            <Users size={40} className="opacity-30" />
            <p className="text-sm">Клієнтів не знайдено</p>
          </div>
        ) : (
          <div>
            {canManageCustomers && (
              <div className="hidden md:flex items-center gap-3 px-5 py-2 border-b border-gray-100 bg-gray-50/50 text-[10px] uppercase tracking-wider text-gray-400 font-semibold">
                <label className="flex items-center gap-2 cursor-pointer" onClick={toggleSelectAll}>
                  <input type="checkbox" checked={isAllSelected} readOnly className="w-3.5 h-3.5 accent-yellow-400 cursor-pointer" />
                  {isAllSelected ? 'Зняти всі' : 'Обрати всі'}
                </label>
                <span className="text-gray-300">|</span>
                <span>{selectedIds.size > 0 ? `Обрано ${selectedIds.size}` : `Завантажено ${customers.length} з ${total}`}</span>
              </div>
            )}

            <div className="divide-y divide-gray-50">
              {customers.map((c) => {
                const isSelected = selectedIds.has(c.id)
                const initial = (c.full_name ?? c.phone ?? '?').trim().charAt(0).toUpperCase() || '?'
                return (
                  <div key={c.id}
                    className={`flex flex-wrap sm:flex-nowrap items-start sm:items-center gap-2 sm:gap-3 px-3 sm:px-5 py-3.5 transition-colors group ${
                      isSelected ? 'bg-yellow-50/50' : 'hover:bg-gray-50/80'
                    }`}
                  >
                    {canManageCustomers && (
                      <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(c.id)}
                        aria-label={`Обрати клієнта ${c.full_name ?? c.phone ?? ''}`}
                        className="w-4 h-4 accent-yellow-400 cursor-pointer shrink-0" />
                    )}

                    <div className="w-9 h-9 rounded-full bg-yellow-100 text-yellow-700 flex items-center justify-center text-sm font-bold shrink-0">
                      {initial}
                    </div>

                    <div className="flex-1 min-w-0">
                      {/* Рядок 1: імʼя + бейджі */}
                      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                        <span
                          className="font-semibold text-gray-900 text-sm break-words sm:truncate cursor-pointer hover:text-yellow-700"
                          onClick={() => setQuickEditCustomer(c)}
                        >
                          {c.full_name ?? <span className="text-gray-400 italic">Без імені</span>}
                        </span>
                        {c.vip_level && c.vip_level !== 'standard' && (
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                            c.vip_level === 'gold' ? 'bg-yellow-100 text-yellow-700' :
                            c.vip_level === 'silver' ? 'bg-gray-200 text-gray-600' : 'bg-orange-100 text-orange-600'
                          }`}>
                            {c.vip_level === 'gold' ? '🥇' : c.vip_level === 'silver' ? '🥈' : '🥉'}
                            {c.vip_level.charAt(0).toUpperCase() + c.vip_level.slice(1)}
                          </span>
                        )}
                        {c.debt_balance > 0 && (
                          <span className="text-[10px] font-semibold text-red-500 bg-red-50 px-1.5 py-0.5 rounded">
                            {formatMoney(c.debt_balance)}
                          </span>
                        )}
                      </div>

                      {/* Рядок 2: телефон (якщо є) + теги */}
                      {(c.phone || (c.tags?.length ?? 0) > 0) && (
                        <div className="flex items-center flex-wrap gap-2 mt-0.5">
                          {c.phone && (
                            <button
                              onClick={() => copyToClipboard(c.phone, 'телефон')}
                              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-50 px-2.5 py-1 font-mono text-sm font-extrabold text-blue-700 hover:bg-yellow-50 hover:text-yellow-700 transition-colors"
                              title="Клік — копіювати"
                            >
                              <Phone size={14} className="opacity-60" />
                              {c.phone}
                            </button>
                          )}
                          {c.tags?.slice(0, 2).map((t) => (
                            <span key={t} className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">{t}</span>
                          ))}
                        </div>
                      )}

                      {/* Штрихкод картки — завжди під рукою, редагується прямо у списку */}
                      <div className="mt-1.5 flex items-center gap-1.5">
                        {editBarcodeId === c.id ? (
                          <div className="flex max-w-full items-center gap-1.5">
                            <Barcode size={14} className="shrink-0 text-yellow-600" />
                            <input
                              autoFocus
                              value={barcodeDraft}
                              disabled={savingBarcode}
                              onChange={(event) => setBarcodeDraft(event.target.value.replace(/\s/g, ''))}
                              onBlur={() => saveBarcode(c)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') event.currentTarget.blur()
                                if (event.key === 'Escape') {
                                  cancelBarcodeEditRef.current = true
                                  setEditBarcodeId(null)
                                  event.currentTarget.blur()
                                }
                              }}
                              placeholder="Скануйте або введіть номер"
                              className="w-56 max-w-[65vw] rounded-lg border border-yellow-400 px-2.5 py-1 font-mono text-sm outline-none focus:ring-2 focus:ring-yellow-300"
                            />
                          </div>
                        ) : c.card_barcode ? (
                          <>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(c.card_barcode, 'штрихкод картки')}
                              className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-yellow-200 bg-yellow-50 px-2.5 py-1 font-mono text-sm font-semibold text-gray-800 hover:bg-yellow-100"
                              title="Клік — копіювати штрихкод картки"
                            >
                              <Barcode size={14} className="shrink-0 text-yellow-700" />
                              <span className="truncate">{c.card_barcode}</span>
                              <Copy size={12} className="shrink-0 opacity-40" />
                            </button>
                            {canManageCustomers && (
                              <button type="button" onClick={() => startBarcodeEdit(c)}
                                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                                title="Змінити штрихкод картки">
                                <Edit size={12} />
                              </button>
                            )}
                          </>
                        ) : canManageCustomers ? (
                          <button type="button" onClick={() => startBarcodeEdit(c)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-500 hover:border-yellow-400 hover:bg-yellow-50 hover:text-yellow-700">
                            <Barcode size={13} /> Додати штрихкод картки
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-gray-400">
                            <Barcode size={12} /> Штрихкод картки не задано
                          </span>
                        )}
                      </div>

                      {/* Рядок 3: VIN — великий, клік = копіювати */}
                      {c.primary_vin && (
                        <button
                          onClick={() => copyToClipboard(c.primary_vin, 'VIN')}
                          title="Клік — копіювати VIN"
                          className="mt-1.5 inline-flex items-center gap-2 font-mono text-sm font-semibold tracking-wider uppercase text-gray-800 bg-gray-100 hover:bg-yellow-100 active:bg-yellow-200 px-2.5 py-1 rounded-lg transition-colors max-w-full"
                        >
                          <Car size={14} className="opacity-50 shrink-0" />
                          <span className="truncate">{c.primary_vin}</span>
                          {(c.car_count ?? 0) > 1 && (
                            <span className="text-[10px] font-sans text-gray-400 shrink-0">+{(c.car_count ?? 1) - 1} авто</span>
                          )}
                          <Copy size={13} className="opacity-40 shrink-0" />
                        </button>
                      )}
                    </div>

                    {/* Швидкі дії */}
                    <div className="basis-full sm:basis-auto flex flex-wrap items-center justify-end gap-1 pl-10 sm:pl-0 opacity-80 sm:opacity-60 group-hover:opacity-100 transition-opacity sm:shrink-0">
                      {c.debt_balance > 0 && (
                        <button
                          onClick={() => copyToClipboard(
                            `Доброго дня${c.full_name ? ', ' + c.full_name : ''}! Нагадуємо про заборгованість ${formatMoney(c.debt_balance)} за замовлення у магазині «Форсаж». Дякуємо!`,
                            'нагадування',
                          )}
                          className="px-2 h-8 flex items-center justify-center rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors text-xs font-semibold"
                          title="Копіювати текст нагадування про борг"
                        >
                          💬 Нагадати
                        </button>
                      )}
                      {c.primary_vin && (
                        <button onClick={() => copyToClipboard(c.primary_vin, 'VIN')}
                          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-yellow-50 text-gray-400 hover:text-yellow-600 transition-colors"
                          title="Копіювати VIN">
                          <Car size={14} />
                        </button>
                      )}
                      {canManageCustomers && (
                        <button onClick={() => setQuickEditCustomer(c)}
                          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                          title="Швидко змінити контакти">
                          <Edit size={14} />
                        </button>
                      )}
                      {c.phone && (
                        <button onClick={() => copyToClipboard(c.phone, `телефон ${c.full_name ?? c.phone}`)}
                          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-yellow-50 text-gray-400 hover:text-yellow-600 transition-colors"
                          title="Копіювати телефон">
                          <Copy size={14} />
                        </button>
                      )}
                      {canDeleteCustomers && (
                        <button onClick={() => handleDelete(c)}
                          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                          title="Видалити">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Sentinel + індикатор дозавантаження (нескінченний скрол) */}
            {hasMore && (
              <div ref={sentinelRef} className="flex items-center justify-center py-5 text-gray-400 text-xs gap-2">
                {loadingMore ? (<><Loader2 size={14} className="animate-spin" /> Завантаження ще…</>) : 'Прокрутіть, щоб показати ще'}
              </div>
            )}
            {!hasMore && customers.length > 0 && (
              <div className="text-center py-4 text-[11px] text-gray-300">Це всі клієнти ({total})</div>
            )}
          </div>
        )}
      </Card>

      {/* Плаваюча панель масових дій */}
      {selectedIds.size > 0 && canManageCustomers && (
        <div className="sticky bottom-0 mt-4 bg-white border border-gray-200 rounded-xl shadow-lg p-3 flex items-center gap-3 animate-slide-up z-30">
          <div className="flex items-center gap-2 text-sm text-gray-600 mr-1">
            <span className="font-semibold text-gray-900">{selectedIds.size}</span>
            <span className="hidden sm:inline">клієнтів обрано</span>
          </div>
          <div className="w-px h-6 bg-gray-200" />
          <select value={bulkGroupId} onChange={(e) => setBulkGroupId(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-yellow-400/50 max-w-[140px]">
            <option value="">➕ В групу...</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <Button size="sm" disabled={!bulkGroupId || bulkOperating} loading={bulkOperating} onClick={handleBulkAddToGroup}>
            Додати
          </Button>
          <div className="w-px h-6 bg-gray-200" />
          <button onClick={handleBulkExportCSV}
            className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 px-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors">
            <Download size={14} /> CSV
          </button>
          <div className="flex-1" />
          <button onClick={() => setSelectedIds(new Set())}
            className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 px-2 py-1.5 rounded-lg hover:bg-gray-100 transition-colors">
            <XIcon size={14} /> Скасувати
          </button>
        </div>
      )}

      <QuickCustomerEditModal
        customer={quickEditCustomer}
        open={!!quickEditCustomer}
        onClose={() => setQuickEditCustomer(null)}
        onSaved={(updated) => {
          setCustomers((current) => current.map((customer) => customer.id === updated.id ? updated : customer))
        }}
      />
      {showScrollTop && (
        <button
          type="button"
          onClick={scrollToTop}
          className="fixed right-5 bottom-5 z-40 w-11 h-11 rounded-full bg-gray-900 text-white shadow-lg hover:bg-yellow-400 hover:text-black transition-colors flex items-center justify-center"
          title="Повернутися на початок списку"
          aria-label="Повернутися на початок списку"
        >
          <ArrowUp size={20} />
        </button>
      )}
    </Layout>
  )
}
