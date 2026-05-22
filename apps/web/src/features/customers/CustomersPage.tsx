import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Users, Copy, Phone, Edit, Trash2, Search, Download, X as XIcon } from 'lucide-react'
import { customerApi } from './customerApi'
import { customerGroupsApi, type CustomerGroup } from './customerGroupsApi'
import { CustomerDrawer } from './CustomerDrawer'
import type { Customer, PaginatedCustomers } from '@/types/customer'
import { Layout } from '@/components/Layout'
import { Button, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'

export default function CustomersPage() {
  const navigate = useNavigate()
  const [result, setResult]       = useState<PaginatedCustomers | null>(null)
  const [search, setSearch]       = useState('')
  const [hasDebt, setHasDebt]     = useState(false)
  const [page, setPage]           = useState(1)
  const [loading, setLoading]     = useState(false)
  const [groups, setGroups]       = useState<CustomerGroup[]>([])
  const [drawerId, setDrawerId]   = useState<string | null>(null)
  const [activeGroup, setActiveGroup] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkGroupId, setBulkGroupId] = useState('')
  const [bulkOperating, setBulkOperating] = useState(false)
  const selectAllRef = useRef<HTMLInputElement>(null)

  // Завантажуємо групи
  useEffect(() => {
    customerGroupsApi.list().then((res) => setGroups(res.data)).catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await customerApi.list({
        search:   search || undefined,
        has_debt: hasDebt ? 'true' : undefined,
        group_id: activeGroup ?? undefined,
        page,
        per_page: 20,
      })
      setResult(data)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка завантаження')
    } finally {
      setLoading(false)
    }
  }, [search, hasDebt, activeGroup, page])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(1); setSelectedIds(new Set()) }, [search, hasDebt, activeGroup])

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard.writeText(text).then(() => {
      toast.success(`Скопійовано: ${label}`)
    }).catch(() => {})
  }

  async function handleDelete(c: Customer) {
    if (!confirm(`Видалити клієнта "${c.full_name ?? c.phone}"?`)) return
    try {
      await customerApi.delete(c.id)
      toast.success('Клієнта видалено')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    }
  }

  // ─── Масові дії ───

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (!result) return
    if (selectedIds.size === result.data.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(result.data.map((c) => c.id)))
    }
  }

  async function handleBulkAddToGroup() {
    if (!bulkGroupId || selectedIds.size === 0) return
    setBulkOperating(true)
    try {
      await customerGroupsApi.addMembers(bulkGroupId, Array.from(selectedIds))
      toast.success(`Додано ${selectedIds.size} клієнтів у групу`)
      setSelectedIds(new Set())
      setBulkGroupId('')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    } finally {
      setBulkOperating(false)
    }
  }

  function handleBulkExportCSV() {
    if (!result || selectedIds.size === 0) return
    const customers = result.data.filter((c) => selectedIds.has(c.id))
    const rows = [
      ['Телефон', 'Ім\'я', 'Email', 'Борг,грн', 'Бонусів,грн', 'VIP', 'Ризик', 'Теги'].join(','),
      ...customers.map((c) =>
        [
          c.phone,
          `"${(c.full_name ?? '').replace(/"/g, '""')}"`,
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
    toast.success(`Експортовано ${customers.length} клієнтів`)
  }

  const groupCount = (g: CustomerGroup): number => g.members?.[0]?.count ?? 0
  const isAllSelected = result ? result.data.length > 0 && selectedIds.size === result.data.length : false

  return (
    <Layout
      title={`Клієнти${result ? ` (${result.pagination.total})` : ''}`}
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
              activeGroup === null
                ? 'bg-yellow-400 text-black'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            👥 Всі
          </button>
          {groups.map((g) => (
            <button key={g.id}
              onClick={() => setActiveGroup(g.id)}
              className={`shrink-0 px-3.5 py-2 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
                activeGroup === g.id
                  ? 'bg-yellow-400 text-black'
                  : 'text-gray-600 hover:bg-gray-200'
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
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Пошук за телефоном або ім'ям..."
            className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400/50"
          />
        </div>
        <Button
          variant={hasDebt ? 'primary' : 'secondary'}
          onClick={() => setHasDebt(!hasDebt)}
          size="sm"
        >
          {hasDebt ? '🔴 З боргом' : 'Борг'}
        </Button>
      </div>

      {/* Список клієнтів */}
      <Card padding="none">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-gray-400 text-sm">Завантаження...</div>
        ) : !result || result.data.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-gray-400">
            <Users size={40} className="opacity-30" />
            <p className="text-sm">Клієнтів не знайдено</p>
          </div>
        ) : (
          <div>
            {/* Header with select-all */}
            <div className="hidden md:flex items-center gap-3 px-5 py-2 border-b border-gray-100 bg-gray-50/50 text-[10px] uppercase tracking-wider text-gray-400 font-semibold">
              <label className="flex items-center gap-2 cursor-pointer" onClick={toggleSelectAll}>
                <input type="checkbox" ref={selectAllRef} checked={isAllSelected} readOnly
                  className="w-3.5 h-3.5 accent-yellow-400 cursor-pointer" />
                {isAllSelected ? 'Зняти всі' : 'Обрати всі'}
              </label>
              <span className="text-gray-300">|</span>
              <span>{selectedIds.size > 0 ? `Обрано ${selectedIds.size}` : `${result.data.length} на сторінці`}</span>
            </div>

            <div className="divide-y divide-gray-50">
              {result.data.map((c) => {
                const isSelected = selectedIds.has(c.id)
                return (
                  <div key={c.id}
                    className={`flex items-center gap-3 px-5 py-3.5 transition-colors group ${
                      isSelected ? 'bg-yellow-50/50' : 'hover:bg-gray-50/80'
                    }`}
                  >
                    {/* Чекбокс */}
                    <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(c.id)}
                      className="w-4 h-4 accent-yellow-400 cursor-pointer shrink-0" />

                    {/* Аватар */}
                    <div className="w-9 h-9 rounded-full bg-yellow-100 text-yellow-700 flex items-center justify-center text-sm font-bold shrink-0">
                      {(c.full_name ?? c.phone)[0].toUpperCase()}
                    </div>

                    {/* Інфо */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className="font-semibold text-gray-900 text-sm truncate cursor-pointer hover:text-yellow-700"
                          onClick={() => navigate(`/customers/${c.id}`)}
                        >
                          {c.full_name ?? <span className="text-gray-400 italic">Без імені</span>}
                        </span>
                        {c.primary_vin && (
                          <button onClick={() => copyToClipboard(c.primary_vin!, 'VIN')}
                            className="font-mono text-[10px] text-gray-400 hover:text-yellow-700 uppercase transition-colors"
                            title="Копіювати VIN">
                            {c.primary_vin}
                          </button>
                        )}
                        {c.vip_level && c.vip_level !== 'standard' && (
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                            c.vip_level === 'gold' ? 'bg-yellow-100 text-yellow-700' :
                            c.vip_level === 'silver' ? 'bg-gray-200 text-gray-600' :
                            'bg-orange-100 text-orange-600'
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
                      <div className="flex items-center gap-2 mt-0.5">
                        <button
                          onClick={() => copyToClipboard(c.phone, 'телефон')}
                          className="font-mono text-xs text-gray-500 hover:text-yellow-700 flex items-center gap-1 transition-colors"
                          title="Клік — копіювати"
                        >
                          <Phone size={11} className="opacity-50" />
                          {c.phone}
                        </button>
                        {c.tags?.length > 0 && c.tags.slice(0, 2).map((t) => (
                          <span key={t} className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* Швидкі дії */}
                    <div className="flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity shrink-0">
                      <button onClick={() => setDrawerId(c.id)}
                        className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition-colors"
                        title="Швидкий перегляд">
                        <Users size={14} />
                      </button>
                      <button onClick={() => navigate(`/customers/${c.id}/edit`)}
                        className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                        title="Редагувати">
                        <Edit size={14} />
                      </button>
                      <button onClick={() => copyToClipboard(c.phone, `телефон ${c.full_name ?? c.phone}`)}
                        className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-yellow-50 text-gray-400 hover:text-yellow-600 transition-colors"
                        title="Копіювати телефон">
                        <Copy size={14} />
                      </button>
                      <button onClick={() => handleDelete(c)}
                        className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                        title="Видалити">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Пагінація */}
        {result && result.pagination.total_pages > 1 && (
          <div className="border-t border-gray-100 px-5 py-3 flex items-center justify-between text-sm text-gray-500">
            <span>
              {result.data.length > 0 && (
                <>Показано {(page - 1) * 20 + 1}–{Math.min(page * 20, result.pagination.total)} з {result.pagination.total}</>
              )}
            </span>
            <div className="flex gap-2 items-center">
              <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>←</Button>
              <span className="px-3 py-1 bg-gray-100 rounded-lg font-medium text-gray-700 text-xs">{page} / {result.pagination.total_pages}</span>
              <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.min(result.pagination.total_pages, p + 1))} disabled={page === result.pagination.total_pages}>→</Button>
            </div>
          </div>
        )}
      </Card>

      {/* Плаваюча панель масових дій */}
      {selectedIds.size > 0 && (
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

          <Button size="sm" disabled={!bulkGroupId || bulkOperating} loading={bulkOperating}
            onClick={handleBulkAddToGroup}>
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

      <CustomerDrawer customerId={drawerId} onClose={() => setDrawerId(null)} />
    </Layout>
  )
}
