import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Upload, CheckCircle, XCircle, AlertCircle } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button, Card, Input, Modal } from '@/components/ui'
import { supplierApi } from './supplierApi'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'
import { useImportPage } from './useImportPage'

export default function ImportPage() {
  const {
    step,
    setStep,
    text,
    setText,
    parsedRows,
    setParsedRows,
    mapping,
    setMapping,
    supplierId,
    setSupplierId,
    invoiceNumber,
    setInvoiceNumber,
    createMissing,
    setCreateMissing,
    result,
    parsing,
    confirming,
    suppliers,
    setSuppliers,
    priceStrategy,
    setPriceStrategy,
    customMarkupPct,
    setCustomMarkupPct,
    manualPrices,
    setManualPrices,
    handleFile,
    processRawText,
    handlePreview,
    handleConfirm,
    matched,
    notFound,
    fuzzy,
    totalKop,
  } = useImportPage()

  const [supplierModal, setSupplierModal] = useState(false)
  const [newSupplierName, setNewSupplierName] = useState('')
  const [newSupplierPhone, setNewSupplierPhone] = useState('')
  const [creatingSupplier, setCreatingSupplier] = useState(false)

  async function handleCreateSupplier() {
    if (!newSupplierName.trim()) {
      toast.error('Назва постачальника обов’язкова')
      return
    }
    setCreatingSupplier(true)
    try {
      const res = await supplierApi.create({
        name: newSupplierName.trim(),
        phone: newSupplierPhone.trim() || null
      })
      toast.success('Постачальника створено')
      const newSup = res.data
      setSuppliers((prev: any) => [...prev, newSup])
      setSupplierId(newSup.id)
      setSupplierModal(false)
      setNewSupplierName('')
      setNewSupplierPhone('')
    } catch {
      toast.error('Помилка створення постачальника')
    } finally {
      setCreatingSupplier(false)
    }
  }

  const navigate = useNavigate()
  const [isDragging, setIsDragging] = useState(false)

  // Prevent browser default drop behavior on the entire window to stop blinking
  useEffect(() => {
    const handleDragOver = (e: DragEvent) => e.preventDefault()
    const handleDrop = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('drop', handleDrop)
    return () => {
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('drop', handleDrop)
    }
  }, [])

  return (
    <Layout
      title="Імпорт накладної"
      onBack={() => {
        if (step === 'review') setStep('mapping')
        else if (step === 'mapping') setStep('paste')
        else navigate('/suppliers/invoices')
      }}
    >
      {step === 'paste' && (
        <div className="max-w-3xl space-y-6">
          {/* Вибір постачальника + кнопка ручного створення */}
          <Card>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1">Постачальник</label>
                <div className="flex gap-2">
                  <select
                    value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value)}
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
                  >
                    <option value="">— Виберіть постачальника —</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => setSupplierModal(true)}
                    className="px-3.5 py-2 bg-yellow-500 hover:bg-yellow-600 text-white font-bold text-sm rounded-lg transition-colors shrink-0">
                    +
                  </button>
                </div>
              </div>
              <div className="flex flex-col gap-2 shrink-0 sm:pt-6">
                <Button
                  variant="outline"
                  onClick={() => navigate('/suppliers/invoices/new')}
                  className="text-xs font-semibold hover:bg-yellow-50 hover:border-yellow-400 hover:text-yellow-700 transition-colors"
                >
                  Створити накладну вручную
                </Button>
              </div>
            </div>
          </Card>

          {/* Завантаження Excel / CSV */}
          <Card className="relative overflow-hidden">
            <h3 className="text-sm font-semibold text-gray-800 mb-3">Завантаження файлу прайсу</h3>
            <div
              onDragOver={(e) => {
                e.preventDefault()
                setIsDragging(true)
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault()
                setIsDragging(false)
                const file = e.dataTransfer.files?.[0]
                if (file) handleFile(file)
              }}
              onClick={() => document.getElementById('excel-file-upload')?.click()}
              className={`border-2 border-dashed rounded-xl p-8 text-center transition cursor-pointer flex flex-col items-center justify-center gap-3 ${
                isDragging
                  ? 'border-yellow-500 bg-yellow-50/50'
                  : 'border-gray-300 bg-gray-50 hover:bg-gray-100 hover:border-yellow-400'
              }`}
            >
              <Upload className={`w-10 h-10 ${isDragging ? 'text-yellow-500' : 'text-gray-400'}`} />
              <div>
                <p className="text-sm font-medium text-gray-700">
                  {parsing ? 'Обробка файлу...' : 'Перетягніть Excel (.xlsx, .xls) або CSV файл сюди'}
                </p>
                <p className="text-xs text-gray-400 mt-1">або натисніть для вибору файлу на комп'ютері</p>
              </div>
              <input
                type="file"
                accept=".xlsx,.xls,.csv,.txt"
                onChange={(e) => {
                  if (e.target.files?.[0]) handleFile(e.target.files[0])
                }}
                className="hidden"
                id="excel-file-upload"
                disabled={parsing}
              />
            </div>
          </Card>

          {/* Вставка скопійованого тексту з буфера */}
          <Card>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-800">Вставити таблицю з буфера</h3>
            </div>

            <p className="text-xs text-gray-500 mb-3">
              Ви можете скопіювати рядки прямо з Excel та вставити їх сюди (Ctrl+V).
            </p>

            <div className="space-y-4">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={8}
                placeholder={'Артикул\tНазва\tКількість\tЦіна\nBP-001\tФільтр оливи\t5\t120.50\n...'}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-yellow-400 resize-y bg-white"
                disabled={parsing}
              />
              <Button
                onClick={() => processRawText(text)}
                disabled={parsing || !text.trim()}
                icon={<Upload size={16} />}
              >
                {parsing ? 'Розпізнаємо...' : 'Розпізнати скопійований текст'}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {step === 'mapping' && parsedRows.length > 0 && (
        <div className="max-w-4xl space-y-6">
          {/* Співставлення колонок */}
          <Card>
            <div className="pb-4 mb-4 border-b border-gray-100 flex items-center justify-between">
              <h3 className="text-base font-semibold text-gray-900">Налаштування відповідності стовпців</h3>
              <span className="text-xs bg-yellow-100 text-yellow-800 font-medium px-2 py-0.5 rounded">Крок 2 з 3</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Артикул (SKU)</label>
                <select
                  value={mapping.sku ?? ''}
                  onChange={(e) =>
                    setMapping({ ...mapping, sku: e.target.value === '' ? null : Number(e.target.value) })
                  }
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
                >
                  <option value="">— Не вказано —</option>
                  {parsedRows[0]?.map((col, idx) => (
                    <option key={idx} value={idx}>
                      Стовпець {idx + 1} ({String(col || '').slice(0, 30) || 'Порожньо'})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Назва товару <span className="text-red-500">*</span>
                </label>
                <select
                  value={mapping.name ?? ''}
                  onChange={(e) =>
                    setMapping({ ...mapping, name: e.target.value === '' ? null : Number(e.target.value) })
                  }
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
                >
                  <option value="">— Виберіть стовпець —</option>
                  {parsedRows[0]?.map((col, idx) => (
                    <option key={idx} value={idx}>
                      Стовпець {idx + 1} ({String(col || '').slice(0, 30) || 'Порожньо'})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Кількість <span className="text-red-500">*</span>
                </label>
                <select
                  value={mapping.qty ?? ''}
                  onChange={(e) =>
                    setMapping({ ...mapping, qty: e.target.value === '' ? null : Number(e.target.value) })
                  }
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
                >
                  <option value="">— Виберіть стовпець —</option>
                  {parsedRows[0]?.map((col, idx) => (
                    <option key={idx} value={idx}>
                      Стовпець {idx + 1} ({String(col || '').slice(0, 30) || 'Порожньо'})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Ціна закупівлі <span className="text-red-500">*</span>
                </label>
                <select
                  value={mapping.price ?? ''}
                  onChange={(e) =>
                    setMapping({ ...mapping, price: e.target.value === '' ? null : Number(e.target.value) })
                  }
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
                >
                  <option value="">— Виберіть стовпець —</option>
                  {parsedRows[0]?.map((col, idx) => (
                    <option key={idx} value={idx}>
                      Стовпець {idx + 1} ({String(col || '').slice(0, 30) || 'Порожньо'})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </Card>

          {/* Таблиця попереднього перегляду */}
          <Card padding="none" className="mb-4 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-800">Попередній перегляд даних (перші 5 рядків)</span>
              <span className="text-xs text-gray-500">Всього рядків у файлі: {parsedRows.length}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-100 border-b border-gray-200 text-xs text-gray-600 uppercase">
                    {parsedRows[0]?.map((_, idx) => {
                      let label = `Стовпець ${idx + 1}`
                      let bgClass = 'bg-gray-100'
                      if (mapping.sku === idx) {
                        label = 'Артикул'
                        bgClass = 'bg-blue-100 text-blue-800 font-semibold border-b border-blue-200'
                      } else if (mapping.name === idx) {
                        label = 'Назва'
                        bgClass = 'bg-green-100 text-green-800 font-semibold border-b border-green-200'
                      } else if (mapping.qty === idx) {
                        label = 'Кількість'
                        bgClass = 'bg-purple-100 text-purple-800 font-semibold border-b border-purple-200'
                      } else if (mapping.price === idx) {
                        label = 'Ціна закупівлі'
                        bgClass = 'bg-yellow-100 text-yellow-800 font-semibold border-b border-yellow-200'
                      }

                      return (
                        <th
                          key={idx}
                          className={`px-4 py-2.5 text-left whitespace-nowrap border-r border-gray-200 last:border-r-0 ${bgClass}`}
                        >
                          {label}
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {parsedRows.slice(0, 5).map((row, rowIdx) => (
                    <tr key={rowIdx} className="border-b border-gray-100 hover:bg-gray-50/50">
                      {row.map((cell, cellIdx) => (
                        <td
                          key={cellIdx}
                          className="px-4 py-2 border-r border-gray-100 last:border-r-0 font-mono text-xs text-gray-600 truncate max-w-xs"
                        >
                          {String(cell ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="flex gap-3">
            <Button onClick={handlePreview} disabled={parsing} icon={<Upload size={16} />}>
              {parsing ? 'Зчитування...' : 'Розпізнати товари'}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setStep('paste')
                setParsedRows([])
              }}
            >
              Назад до вставки
            </Button>
          </div>
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
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 uppercase border-b border-gray-100 bg-gray-50">
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
                            <div key={i} className="text-xs text-orange-500">
                              {w}
                            </div>
                          ))}
                        </td>
                        <td className="px-2 py-2 text-right">{item.qty}</td>
                        <td className="px-4 py-2 text-right font-mono">{formatMoney(item.price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Не знайдено */}
          {notFound.length > 0 && (
            <Card padding="none" className="mb-4">
              <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
                <XCircle size={16} className="text-red-500" />
                <span className="text-sm font-semibold text-gray-850">
                  Не знайдено ({notFound.length})
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 uppercase border-b border-gray-100 bg-gray-50">
                      <th className="text-left px-4 py-2">Артикул</th>
                      <th className="text-left px-4 py-2">Назва</th>
                      <th className="text-right px-2 py-2 w-20">К-сть</th>
                      <th className="text-right px-4 py-2 w-28">Ціна закупівлі</th>
                      {createMissing && <th className="text-right px-4 py-2 w-36">Роздрібна ціна (₴)</th>}
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
                                [item.row]: e.target.value,
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
                          {createMissing && <td className="px-4 py-2 text-right">{retailDisplay}</td>}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-3 border-t border-gray-100">
                <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={createMissing}
                    onChange={(e) => setCreateMissing(e.target.checked)}
                    className="rounded border-gray-300 text-yellow-500 focus:ring-yellow-400"
                  />
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
                <div className="flex gap-2">
                  <select
                    value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value)}
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
                  >
                    <option value="">— Без постачальника —</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => setSupplierModal(true)}
                    className="px-3.5 py-2 bg-yellow-500 hover:bg-yellow-600 text-white font-bold text-sm rounded-lg transition-colors shrink-0">
                    +
                  </button>
                </div>
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
              {confirming
                ? 'Створюємо...'
                : 'Створити накладну (' + (createMissing ? result.total_items : matched.length) + ' поз.)'}
            </Button>
            <Button variant="outline" onClick={() => setStep('mapping')}>
              Назад до зіставлення
            </Button>
          </div>
        </div>
      )}
      {/* Швидке створення постачальника */}
      <Modal open={supplierModal} onClose={() => setSupplierModal(false)} title="Швидке створення постачальника" size="sm">
        <div className="space-y-4">
          <Input label="Назва постачальника *" value={newSupplierName} onChange={(e) => setNewSupplierName(e.target.value)} placeholder="ТОВ Запчастини..." required />
          <Input label="Телефон" value={newSupplierPhone} onChange={(e) => setNewSupplierPhone(e.target.value)} placeholder="+380..." />
          <div className="flex gap-3">
            <Button loading={creatingSupplier} onClick={handleCreateSupplier} className="flex-1">
              Створити
            </Button>
            <Button variant="secondary" onClick={() => setSupplierModal(false)}>Скасувати</Button>
          </div>
        </div>
      </Modal>
    </Layout>
  )
}
