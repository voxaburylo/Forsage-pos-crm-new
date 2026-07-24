import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { api } from '@/lib/api'
import { productApi } from '@/features/products/productApi'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { supplierImportsApi } from '@/features/suppliers/supplierImportsApi'
import type { Product } from '@/types/product'
import { formatMoney } from '@/lib/utils'
import { toast } from '@/components/ui/Toast'
import { loadDesktopAutocompleteSuggestions } from './productAutocompleteSearch'

interface ProductAutocompleteProps {
  value: string
  onChange: (val: string) => void
  /** Викликається при виборі товару з каталогу — підставляє SKU/ціну/тощо. */
  onSelect: (product: Product) => void
  placeholder?: string
  className?: string
  required?: boolean
  /** Лише товари зі складу (без прайсів постачальників і замовного імпорту).
   *  Для контекстів складу: списання, переміщення, внутр. відпуск тощо. */
  warehouseOnly?: boolean
}

/**
 * Спільний пікер товару з автопідказкою по базі (общий модуль пошуку).
 * Друк → випадають збіги (назва, артикул, ціна, залишок).
 * За замовчуванням показує і прайси постачальників (замовний імпорт);
 * з warehouseOnly — лише склад.
 */
function sortSuggestions(list: Product[]): Product[] {
  return [...list].sort((a, b) => {
    const aStock = Number(a.qty_available ?? a.qty_on_hand ?? 0)
    const bStock = Number(b.qty_available ?? b.qty_on_hand ?? 0)
    const aReady = aStock > 0 || a.is_service
    const bReady = bStock > 0 || b.is_service
    if (aReady !== bReady) return aReady ? -1 : 1
    return (a.name || '').localeCompare(b.name || '', 'uk', { numeric: true, sensitivity: 'base' })
  })
}
export function ProductAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder = 'Введіть назву або артикул...',
  className = '',
  required,
  warehouseOnly = false,
}: ProductAutocompleteProps) {
  const [results, setResults] = useState<Product[]>([])
  const [supplierResults, setSupplierResults] = useState<any[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [importingId, setImportingId] = useState<string | null>(null)
  const [pricingModalItem, setPricingModalItem] = useState<any | null>(null)
  const [pricingRetailPrice, setPricingRetailPrice] = useState<string>('')
  const [highlight, setHighlight] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [dropdownStyle, setDropdownStyle] = useState<CSSProperties>({})
  const justSelected = useRef(false)
  const searchRequestRef = useRef(0)

  // Форма замовлення рендерить дві копії поля — картку (md:hidden) і рядок
  // таблиці (hidden md:block). CSS-приховування не розмонтовує React, тож
  // прихована копія теж реагувала на ввід і відкривала ДРУГИЙ дропдаун через
  // портал (у кутку, з нульовими координатами). Відкриваємо лише видиму копію.
  function isElementVisible() {
    return !!wrapRef.current && wrapRef.current.offsetParent !== null
  }

  function updateDropdownPosition() {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const bottomSpace = viewportHeight - rect.bottom - 8
    const topSpace = rect.top - 8
    const openBelow = bottomSpace >= 220 || bottomSpace >= topSpace
    const availableHeight = openBelow ? bottomSpace : topSpace
    const maxHeight = Math.max(120, Math.min(420, availableHeight))
    const preferredWidth = Math.min(Math.max(rect.width, 380), viewportWidth - 16)
    const left = Math.min(Math.max(8, rect.left), viewportWidth - preferredWidth - 8)
    setDropdownStyle(openBelow
      ? { top: rect.bottom + 4, left, width: preferredWidth, maxHeight }
      : { bottom: viewportHeight - rect.top + 4, left, width: preferredWidth, maxHeight })
  }

  // Закриття при кліку поза полем. Панель підказок винесена поверх таблиці, тому перевіряємо і input, і портал.
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      const target = e.target as Node
      if (wrapRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  useEffect(() => {
    if (!open) return
    updateDropdownPosition()
    window.addEventListener('resize', updateDropdownPosition)
    window.addEventListener('scroll', updateDropdownPosition, true)
    return () => {
      window.removeEventListener('resize', updateDropdownPosition)
      window.removeEventListener('scroll', updateDropdownPosition, true)
    }
  }, [open, results.length, supplierResults.length])

  // У desktop підказки беруться безпосередньо з SQLite і не чекають мережу.
  useEffect(() => {
    if (justSelected.current) {
      justSelected.current = false
      setLoading(false)
      return
    }
    const q = value.trim()
    if (q.length < 2) {
      searchRequestRef.current += 1
      setResults([])
      setSupplierResults([])
      setOpen(false)
      setLoading(false)
      return
    }

    const requestId = ++searchRequestRef.current
    let cancelled = false
    setLoading(true)
    const t = window.setTimeout(async () => {
      try {
        if (isDesktopRuntime()) {
          const local = await loadDesktopAutocompleteSuggestions(
            q,
            warehouseOnly,
            (query, limit) => productApi.search(query, limit).then((response) => response.data ?? []),
            (query, limit) => supplierImportsApi.getCatalog({ q: query, page: 1, limit })
              .then((response) => response.data ?? []),
          )
          if (cancelled || requestId !== searchRequestRef.current) return
          setResults(sortSuggestions(local.warehouse))
          setSupplierResults(local.supplierCatalog)
          updateDropdownPosition()
          setOpen((local.warehouse.length > 0 || local.supplierCatalog.length > 0) && isElementVisible())
          setHighlight(0)
          return
        }
        const res = await api.get<{ data: { warehouse: Product[], supplier_catalog: any[] } }>(`/api/v1/search/hybrid?q=${encodeURIComponent(q)}&limit=8`)
        if (cancelled || requestId !== searchRequestRef.current) return
        const warehouse = res.data?.warehouse || []
        const catalog = warehouseOnly ? [] : (res.data?.supplier_catalog || [])
        setResults(sortSuggestions(warehouse))
        setSupplierResults(catalog)
        updateDropdownPosition()
        setOpen((warehouse.length > 0 || catalog.length > 0) && isElementVisible())
        setHighlight(0)
      } catch {
        if (!cancelled && requestId === searchRequestRef.current) {
          setResults([])
          setSupplierResults([])
          setOpen(false)
        }
      } finally {
        if (!cancelled && requestId === searchRequestRef.current) setLoading(false)
      }
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [value, warehouseOnly])
  function pick(p: Product) {
    searchRequestRef.current += 1
    justSelected.current = true
    onSelect(p)
    setLoading(false)
    setOpen(false)
    setResults([])
    setSupplierResults([])
  }

  function openPricingModal(sItem: any) {
    searchRequestRef.current += 1
    setLoading(false)
    setOpen(false)
    const purchase = sItem.price_kopecks / 100
    const val = Math.round(purchase * 1.3)
    setPricingRetailPrice(String(val))
    setPricingModalItem(sItem)
  }

  async function handleImportConfirm() {
    if (!pricingModalItem) return
    const retailVal = parseFloat(pricingRetailPrice)
    if (isNaN(retailVal) || retailVal <= 0) {
      toast.error('Будь ласка, введіть роздрібну ціну')
      return
    }

    setImportingId(pricingModalItem.id)
    try {
      const res = await supplierImportsApi.importOnDemand({
        sku: pricingModalItem.sku,
        barcode: pricingModalItem.barcode ?? null,
        brand: pricingModalItem.brand || '',
        name: pricingModalItem.name,
        supplier_id: pricingModalItem.supplier?.id || null,
        purchase_price: pricingModalItem.price_kopecks,
        retail_price: Math.round(retailVal * 100)
      })
      if (res.data) {
        pick(res.data)
        setPricingModalItem(null)
      }
    } catch (err: any) {
      toast.error(err.message || 'Помилка імпорту замовного товару')
    } finally {
      setImportingId(null)
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const totalCount = results.length + supplierResults.length
    if (!open || totalCount === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, totalCount - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter') { 
      e.preventDefault()
      if (highlight < results.length) {
        pick(results[highlight])
      } else {
        openPricingModal(supplierResults[highlight - results.length])
      }
    }
    else if (e.key === 'Escape') { setOpen(false) }
  }

  return (
    <div ref={wrapRef} className="relative">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => { if ((results.length > 0 || supplierResults.length > 0) && isElementVisible()) { updateDropdownPosition(); setOpen(true) } }}
        placeholder={placeholder}
        required={required}
        autoComplete="off"
        className={className || 'w-full bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-yellow-400'}
      />
      {open && (loading || results.length > 0 || supplierResults.length > 0) && typeof document !== 'undefined' && createPortal(
        <div ref={panelRef} style={dropdownStyle} className="fixed z-[180] bg-white border border-gray-200 rounded-xl shadow-2xl overflow-y-auto divide-y divide-gray-100" onMouseDown={(e) => e.stopPropagation()}>

          
          {/* Складські товари */}
          {results.length > 0 && (
            <div className="py-1">
              <div className="px-3 py-1 text-[9px] font-bold text-gray-400 uppercase bg-gray-50 tracking-wider">
                📦 Товари в базі / аналоги
              </div>
              {results.map((p, idx) => {
                const stock = p.qty_available ?? p.qty_on_hand ?? 0
                const isHighlighted = idx === highlight
                return (
                  <button
                    key={p.id}
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); pick(p) }}
                    onMouseEnter={() => setHighlight(idx)}
                    className={`w-full text-left px-3 py-1.5 transition-colors ${
                      isHighlighted ? 'bg-yellow-50 font-medium' : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-gray-800 truncate">{p.name}</span>
                      <span className="text-xs font-bold text-yellow-600 shrink-0">{formatMoney(p.retail_price)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <span className="text-[10px] text-gray-400 font-mono truncate">
                        {p.sku} {p.brand && `• ${p.brand.name}`}
                      </span>
                      <span className={`text-[10px] shrink-0 font-semibold ${
                        stock > 0 ? 'text-green-600' : 'text-gray-400'
                      }`}>
                        {stock > 0 ? `На складі: ${stock}` : 'Немає на складі'}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}

          {/* Прайси постачальників */}
          {supplierResults.length > 0 && (
            <div className="py-1">
              <div className="px-3 py-1 text-[9px] font-bold text-gray-400 uppercase bg-gray-50 tracking-wider">
                🚚 У прайсах постачальників
              </div>
              {supplierResults.map((sItem, idx) => {
                const globalIdx = idx + results.length
                const isHighlighted = globalIdx === highlight
                const isImporting = importingId === sItem.id
                return (
                  <button
                    key={sItem.id}
                    type="button"
                    disabled={isImporting}
                    onMouseDown={(e) => { e.preventDefault(); openPricingModal(sItem) }}
                    onMouseEnter={() => setHighlight(globalIdx)}
                    className={`w-full text-left px-3 py-1.5 transition-colors disabled:opacity-50 ${
                      isHighlighted ? 'bg-yellow-50 font-medium' : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-gray-700 truncate">{sItem.name}</span>
                      <span className="text-xs font-bold text-gray-600 shrink-0">
                        {formatMoney(sItem.price_kopecks)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <span className="text-[10px] text-gray-400 font-mono truncate">
                        {sItem.sku} {sItem.brand && `• ${sItem.brand}`}
                      </span>
                      <span className="text-[10px] shrink-0 text-yellow-600 font-semibold font-medium">
                        {isImporting ? 'Імпорт...' : `Замовний (${sItem.supplier?.name || '—'}${sItem.warehouse_name ? `, ${sItem.warehouse_name}` : ''})`}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>,
        document.body,
      )}
      {/* Модальне вікно встановлення ціни для замовного товару */}
      {pricingModalItem && (
        <div className="fixed inset-0 z-[160] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white border border-gray-200 rounded-2xl max-w-md w-full p-6 shadow-2xl animate-scale-up text-left">
            <h3 className="text-gray-900 text-lg font-bold mb-2 flex items-center gap-2">
              <span>💰 Ціноутворення та імпорт</span>
            </h3>
            <p className="text-gray-500 text-xs mb-4">
              Вкажіть роздрібну ціну для товару: <strong className="text-gray-800">{pricingModalItem.name}</strong> ({pricingModalItem.sku})
            </p>

            <div className="space-y-4">
              <div>
                <span className="block text-[10px] text-gray-400 font-semibold uppercase tracking-wider mb-1">Ціна закупівлі</span>
                <div className="text-gray-800 text-base font-semibold bg-gray-50 px-3 py-2 rounded-lg border border-gray-200/80">
                  {formatMoney(pricingModalItem.price_kopecks)}
                </div>
              </div>

              <div>
                <label className="block text-[10px] text-gray-400 font-semibold uppercase tracking-wider mb-1">
                  Ціна продажу (роздрібна), ₴
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={pricingRetailPrice}
                  onChange={(e) => setPricingRetailPrice(e.target.value)}
                  className="w-full bg-white border border-gray-300 focus:border-yellow-400 focus:outline-none focus:ring-1 focus:ring-yellow-400 text-gray-950 rounded-lg px-3 py-2 text-lg font-bold transition"
                  placeholder="0.00"
                  autoFocus
                />
              </div>

              {/* Швидкі націнки */}
              <div>
                <span className="block text-[10px] text-gray-400 font-semibold uppercase tracking-wider mb-1.5">
                  Швидка націнка
                </span>
                <div className="flex flex-wrap gap-2">
                  {[10, 20, 30, 40, 50].map((pct) => {
                    const purchase = pricingModalItem.price_kopecks / 100
                    const val = Math.round(purchase * (1 + pct / 100))
                    return (
                      <button
                        key={pct}
                        type="button"
                        onClick={() => setPricingRetailPrice(String(val))}
                        className="text-[10px] font-semibold bg-gray-100 hover:bg-yellow-400 hover:text-black border border-gray-200 px-2.5 py-1.5 rounded-lg text-gray-700 transition active:scale-95"
                      >
                        +{pct}% ({val} ₴)
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Інформація про маржу */}
              {(() => {
                const retail = parseFloat(pricingRetailPrice)
                const purchase = pricingModalItem.price_kopecks / 100
                if (!isNaN(retail) && retail > 0) {
                  const profit = retail - purchase
                  const pct = purchase > 0 ? (profit / purchase) * 100 : 0
                  return (
                    <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 flex justify-between text-xs">
                      <span className="text-gray-500">Чистий прибуток:</span>
                      <span className={`font-bold ${profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {profit.toFixed(2)} ₴ ({pct.toFixed(0)}%)
                      </span>
                    </div>
                  )
                }
                return null
              })()}

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setPricingModalItem(null)}
                  className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-2 rounded-xl transition text-sm active:scale-95"
                >
                  Скасувати
                </button>
                <button
                  type="button"
                  onClick={handleImportConfirm}
                  disabled={importingId === pricingModalItem.id}
                  className="flex-1 bg-yellow-500 hover:bg-yellow-400 text-black font-semibold py-2 rounded-xl transition text-sm active:scale-95 disabled:opacity-50 flex items-center justify-center gap-1.5"
                >
                  {importingId === pricingModalItem.id ? (
                    <>
                      <span>Імпорт...</span>
                    </>
                  ) : (
                    <>
                      <span>Імпортувати</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
