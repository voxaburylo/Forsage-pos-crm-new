import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Upload, CheckCircle, XCircle, AlertCircle } from 'lucide-react'
import { importApi } from './importApi'
import type { ParseResult } from './importApi'
import { supplierApi } from './supplierApi'
import { Layout } from '@/components/Layout'
import { Button, Card, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'

type Step = 'paste' | 'review'

export default function ImportPage() {
  const navigate = useNavigate()
  const [step, setStep]               = useState<Step>('paste')
  const [text, setText]               = useState('')
  const [supplierId, setSupplierId]   = useState('')
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [createMissing, setCreateMissing] = useState(false)
  const [result, setResult]           = useState<ParseResult | null>(null)
  const [parsing, setParsing]         = useState(false)
  const [confirming, setConfirming]   = useState(false)
  const [suppliers, setSuppliers]     = useState<Array<{ id: string; name: string }>>([])
  type PriceStrategy = 'grid' | 'percent' | 'manual'
  const [priceStrategy, setPriceStrategy] = useState<PriceStrategy>('grid')
  const [customMarkupPct, setCustomMarkupPct] = useState('30')
  const [manualPrices, setManualPrices] = useState<Record<number, string>>({})

  useEffect(() => {
    supplierApi.list({ per_page: 200 }).then((r) => setSuppliers(r.data)).catch(() => {})
  }, [])

  async function handleParse() {
    if (!text.trim()) { toast.error('Вставте текст таблиці'); return }
    setParsing(true)
    try {
      const res = await importApi.parse({ text, supplier_id: supplierId || null })
      setResult(res)
      
      const initialManual: Record<number, string> = {}
      res.items.forEach((item) => {
        if (!item.matched) {
          initialManual[item.row] = (Math.round(item.price * 1.3) / 100).toFixed(2)
        }
      })
      setManualPrices(initialManual)
      
      setStep('review')
      if (res.matched_count === 0) {
        toast.warning('Жодного товару не знайдено в базі')
      } else {
        toast.success(res.matched_count + ' товарів знайдено з ' + res.total_items)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка парсингу')
    } finally {
      setParsing(false)
    }
  }

  async function handleConfirm() {
    if (!result) return
    const matchedItems = result.items.filter((i) => i.matched || createMissing)
    if (matchedItems.length === 0) { toast.error('Немає товарів для створення накладної'); return }

    let finalItems = result.items

    if (createMissing && notFound.length > 0) {
      if (priceStrategy === 'manual') {
        for (const item of notFound) {
          const valStr = manualPrices[item.row]
          const priceVal = valStr ? parseFloat(valStr) : 0
          if (isNaN(priceVal) || priceVal <= 0) {
            toast.error(`Будь ласка, вкажіть коректну роздрібну ціну для "${item.name}" (рядок ${item.row})`)
            return
          }
        }
      }

      finalItems = result.items.map((item) => {
        if (item.matched) return item

        let retailPriceCents: number | null = null
        if (priceStrategy === 'percent') {
          const pct = parseFloat(customMarkupPct) || 0
          retailPriceCents = Math.round(item.price * (1 + pct / 100))
        } else if (priceStrategy === 'manual') {
          const valStr = manualPrices[item.row]
          retailPriceCents = Math.round(parseFloat(valStr) * 100)
        }

        return {
          ...item,
          retail_price: retailPriceCents,
        }
      })
    }

    setConfirming(true)
    try {
      const res = await importApi.confirm({
        items:          finalItems,
        supplier_id:    supplierId || null,
        invoice_number: invoiceNumber.trim() || null,
        create_missing: createMissing,
        update_retail:  priceStrategy === 'grid',
      })
      toast.success('Накладну створено')
      navigate('/suppliers/invoices/' + res.data.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка створення накладної')
    } finally {
      setConfirming(false)
    }
  }

  const matched    = result?.items.filter((i) => i.matched)        ?? []
  const notFound   = result?.items.filter((i) => !i.matched)       ?? []
  const fuzzy      = matched.filter((i) => i.match_quality === 'fuzzy')
  const totalKop   = matched.reduce((s, i) => s + i.qty * i.price, 0)

  return (
    <Layout
      title="Імпорт накладної"
      onBack={() => step === 'review' ? setStep('paste') : navigate('/suppliers/invoices')}
    >
      {step === 'paste' && (
        <div className="max-w-2xl">
          <Card className="mb-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4 pb-4 border-b border-gray-100">
              <p className="text-sm text-gray-600">
                Скопіюйте таблицю з прайс-листу постачальника (Excel, сайт, PDF) та вставте нижче.
                Система автоматично визначить колонки: Артикул, Назва, Кількість, Ціна.
              </p>
              <Button 
                variant="outline" 
                onClick={() => navigate('/suppliers/bulk-import')}
                className="shrink-0 text-xs"
              >
                Пакетний імпорт прайсів (CSV)
              </Button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Постачальник</label>
                <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400">
                  <option value="">— Без постачальника —</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Вставте таблицю (Ctrl+V)
                </label>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={12}
                  placeholder={'Артикул\tНазва\tКількість\tЦіна\nBP-001\tФільтр оливи\t5\t120.50\n...'}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-yellow-400 resize-y"
                />
              </div>

              <Button onClick={handleParse} disabled={parsing || !text.trim()} icon={<Upload size={16} />}>
                {parsing ? 'Розпізнаємо...' : 'Розпізнати таблицю'}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {step === 'review' && result && (
        <div>
          {/* Підсумок */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <Card className="text-center">
              <CheckCircle size={24} className="text-green-500 mx-auto mb-1" />
              <div className="text-2xl font-bold text-green-700">{matched.length}</div>
              <div className="text-xs text-gray-500">Знайдено</div>
            </Card>
            <Card className="text-center">
              <AlertCircle size={24} className="text-orange-500 mx-auto mb-1" />
              <div className="text-2xl font-bold text-orange-600">{fuzzy.length}</div>
              <div className="text-xs text-gray-500">Приблизний збіг</div>
            </Card>
            <Card className="text-center">
              <XCircle size={24} className="text-red-400 mx-auto mb-1" />
              <div className="text-2xl font-bold text-red-600">{notFound.length}</div>
              <div className="text-xs text-gray-500">Не знайдено</div>
            </Card>
          </div>

          {/* Знайдені товари */}
          {matched.length > 0 && (
            <Card padding="none" className="mb-4">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                <CheckCircle size={16} className="text-green-500" />
                <span className="text-sm font-semibold text-gray-800">Знайдено ({matched.length})</span>
                <span className="ml-auto text-sm text-gray-500">Сума: {formatMoney(totalKop)}</span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 uppercase border-b border-gray-100">
                    <th className="text-left px-4 py-2">Артикул / Назва в прайсі</th>
                    <th className="text-left px-4 py-2">Товар в базі</th>
                    <th className="text-right px-2 py-2 w-20">К-сть</th>
                    <th className="text-right px-4 py-2 w-28">Ціна</th>
                  </tr>
                </thead>
                <tbody>
                  {matched.map((item) => (
                    <tr key={item.row} className="border-b border-gray-50 hover:bg-gray-50/50">
                      <td className="px-4 py-2">
                        <div className="font-mono text-xs text-gray-400">{item.sku || '—'}</div>
                        <div className="text-gray-600 text-xs">{item.name}</div>
                        {item.match_quality === 'fuzzy' && (
                          <span className="text-xs text-orange-500">~ приблизний збіг</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {item.warnings.map((w, i) => (
                          <div key={i} className="text-xs text-orange-500">{w}</div>
                        ))}
                      </td>
                      <td className="px-2 py-2 text-right">{item.qty}</td>
                      <td className="px-4 py-2 text-right font-mono">{formatMoney(item.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          {/* Не знайдені */}
          {notFound.length > 0 && (
            <Card padding="none" className="mb-4">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                <XCircle size={16} className="text-red-400" />
                <span className="text-sm font-semibold text-gray-800">Не знайдено ({notFound.length})</span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 uppercase border-b border-gray-100">
                    <th className="text-left px-4 py-2">Артикул</th>
                    <th className="text-left px-4 py-2">Назва з прайсу</th>
                    <th className="text-right px-2 py-2 w-20">К-сть</th>
                    <th className="text-right px-4 py-2 w-28">Ціна закупівлі</th>
                    {createMissing && (
                      <th className="text-right px-4 py-2 w-36">Роздрібна ціна (₴)</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {notFound.map((item) => {
                    let retailDisplay: React.ReactNode = null
                    if (priceStrategy === 'grid') {
                      retailDisplay = <span className="text-xs text-gray-400 italic">Авто (сітка)</span>
                    } else if (priceStrategy === 'percent') {
                      const markup = parseFloat(customMarkupPct) || 0
                      const calcPrice = Math.round(item.price * (1 + markup / 100)) / 100
                      retailDisplay = <span className="font-mono text-gray-600">{calcPrice.toFixed(2)}</span>
                    } else if (priceStrategy === 'manual') {
                      retailDisplay = (
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={manualPrices[item.row] ?? ''}
                          onChange={(e) => {
                            setManualPrices({
                              ...manualPrices,
                              [item.row]: e.target.value
                            })
                          }}
                          className="w-24 text-right border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-yellow-400"
                          placeholder="0.00"
                        />
                      )
                    }

                    return (
                      <tr key={item.row} className="border-b border-gray-50 bg-red-50/30">
                        <td className="px-4 py-2 font-mono text-xs text-gray-400">{item.sku || '—'}</td>
                        <td className="px-4 py-2 text-gray-600 text-xs">{item.name}</td>
                        <td className="px-2 py-2 text-right">{item.qty}</td>
                        <td className="px-4 py-2 text-right font-mono">{formatMoney(item.price)}</td>
                        {createMissing && (
                          <td className="px-4 py-2 text-right">
                            {retailDisplay}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <div className="px-4 py-3 border-t border-gray-100">
                <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input type="checkbox" checked={createMissing}
                    onChange={(e) => setCreateMissing(e.target.checked)}
                    className="rounded border-gray-300" />
                  Автоматично створити нові товари для незнайдених позицій
                </label>

                {createMissing && (
                  <div className="mt-4 pl-6 border-l-2 border-yellow-400 space-y-4">
                    <div>
                      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                        Встановлення роздрібних цін для нових товарів:
                      </div>
                      <div className="flex flex-col sm:flex-row gap-4">
                        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                          <input
                            type="radio"
                            name="priceStrategy"
                            value="grid"
                            checked={priceStrategy === 'grid'}
                            onChange={() => setPriceStrategy('grid')}
                            className="text-yellow-500 focus:ring-yellow-400"
                          />
                          За сіткою націнок (авто)
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                          <input
                            type="radio"
                            name="priceStrategy"
                            value="percent"
                            checked={priceStrategy === 'percent'}
                            onChange={() => setPriceStrategy('percent')}
                            className="text-yellow-500 focus:ring-yellow-400"
                          />
                          Єдиний відсоток націнки
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                          <input
                            type="radio"
                            name="priceStrategy"
                            value="manual"
                            checked={priceStrategy === 'manual'}
                            onChange={() => setPriceStrategy('manual')}
                            className="text-yellow-500 focus:ring-yellow-400"
                          />
                          Вручну для кожного
                        </label>
                      </div>
                    </div>

                    {priceStrategy === 'percent' && (
                      <div className="flex items-center gap-2 bg-gray-50 p-2.5 rounded-lg max-w-xs border border-gray-100">
                        <span className="text-xs font-medium text-gray-600">Відсоток націнки:</span>
                        <div className="relative flex items-center">
                          <input
                            type="number"
                            min="0"
                            value={customMarkupPct}
                            onChange={(e) => setCustomMarkupPct(e.target.value)}
                            className="w-20 border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-yellow-400 text-right pr-6"
                          />
                          <span className="absolute right-2 text-xs text-gray-400">%</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </Card>
          )}

          {/* Форма накладної */}
          <Card className="mb-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Постачальник</label>
                <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400">
                  <option value="">— Без постачальника —</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <Input
                label="Номер накладної"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                placeholder="Номер від постачальника"
              />
            </div>
          </Card>

          <div className="flex gap-3">
            <Button
              onClick={handleConfirm}
              disabled={confirming || (matched.length === 0 && !createMissing)}
            >
              {confirming ? 'Створюємо...' : 'Створити накладну (' + (createMissing ? result.total_items : matched.length) + ' поз.)'}
            </Button>
            <Button variant="outline" onClick={() => setStep('paste')}>
              Назад до вставки
            </Button>
          </div>
        </div>
      )}
    </Layout>
  )
}
