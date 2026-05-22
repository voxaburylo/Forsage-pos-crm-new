import { useState, useRef } from 'react'
import {
  Upload,
  Download,
  FileText,
  X,
  Clipboard,
  Table2,
  FileSpreadsheet,
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  Info,
  ArrowRight
} from 'lucide-react'
import Papa from 'papaparse'
import { api } from '@/lib/api'
import { toast } from '@/components/ui/Toast'

interface Props { onClose: () => void; onImported: () => void }

interface ColumnMapping {
  sku: number | null
  name: number | null
  qty: number | null
  price: number | null
  retail_price: number | null
  barcode: number | null
  storage_bin: number | null
}

interface PreviewItem {
  row: number
  sku: string
  name: string
  qty: number
  price: number
  retail_price: number | null
  barcode: string | null
  storage_bin: string | null
  matched: boolean
  product_id: string | null
  match_quality?: 'exact' | 'fuzzy' | 'new'
  warnings: string[]
  old_price?: number | null
  old_qty?: number | null
  old_retail_price?: number | null
}

interface PreviewConflict {
  row: number
  sku?: string
  name?: string
  qty?: number
  price?: number
  reason: string
}

interface PreviewResponse {
  items: PreviewItem[]
  conflicts: PreviewConflict[]
  summary: {
    toCreate: number
    toUpdate: number
    conflicts: number
  }
}

type Tab = 'file' | 'paste' | 'quick'
type Step = 'source' | 'mapping' | 'preview' | 'success'

const TEMPLATE_TSV = 'Артикул\tНазва\tЗакупівельнаЦіна\tРоздрібнаЦіна\tЗалишок\tШтрихкод\tКомірка\nW712\tФільтр оливний Mann\t220.00\t380.00\t15\t4011558737604\tA-12\nB005\tМасло моторне 5W-40\t450.00\t720.00\t8\t4047024367612\tB-03'

export function ImportModal({ onClose, onImported }: Props) {
  // Загальний стан майстра
  const [step, setStep] = useState<Step>('source')
  const [tab, setTab] = useState<Tab>('file')
  const [rawText, setRawText] = useState('')
  const [quickText, setQuickText] = useState('')
  
  // Файловий стан
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Парсинг та зіставлення (Step 2)
  const [parsedRows, setParsedRows] = useState<string[][]>([])
  const [mapping, setMapping] = useState<ColumnMapping>({
    sku: null,
    name: null,
    qty: null,
    price: null,
    retail_price: null,
    barcode: null,
    storage_bin: null,
  })

  // Попередній перегляд (Step 3)
  const [previewData, setPreviewData] = useState<PreviewResponse | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [previewTab, setPreviewTab] = useState<'create' | 'update' | 'conflicts'>('create')
  
  // Опції імпорту
  const [mode, setMode] = useState<'replace' | 'add'>('replace')
  const [updateRetail, setUpdateRetail] = useState(true)
  const [createMissing, setCreateMissing] = useState(true)

  // Результат (Step 4)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{ created: number; updated: number; errors: number } | null>(null)

  // Отримання першого рядка або заголовків для автовизначення мапінгу
  function autoGuessMapping(headers: string[]) {
    const newMapping: ColumnMapping = {
      sku: null,
      name: null,
      qty: null,
      price: null,
      retail_price: null,
      barcode: null,
      storage_bin: null,
    }

    headers.forEach((h, index) => {
      const header = h.toLowerCase().trim()
      
      if (/артикул|sku|article|код|арт/i.test(header) && newMapping.sku === null) {
        newMapping.sku = index
      } else if (/назва|name|товар|product|наименование|описание/i.test(header) && newMapping.name === null) {
        newMapping.name = index
      } else if (/закупівельна|собівартість|purchase|buy.?price|цена.закупки/i.test(header) && newMapping.price === null) {
        newMapping.price = index
      } else if (/ціна|роздріб|retail|ціна.роздр|цена.продажи|продаж/i.test(header) && newMapping.retail_price === null) {
        // перевіримо чи це не закупка
        if (!/закуп|собіварт/i.test(header)) {
          newMapping.retail_price = index
        }
      } else if (/залишок|stock|qty|quantity|к-сть|кол|кількість/i.test(header) && newMapping.qty === null) {
        newMapping.qty = index
      } else if (/штрихкод|barcode|штрих.код|штрих/i.test(header) && newMapping.barcode === null) {
        newMapping.barcode = index
      } else if (/комірка|cell|bin|storage|місце/i.test(header) && newMapping.storage_bin === null) {
        newMapping.storage_bin = index
      }
    })

    // Fallbacks якщо автовизначення не знайшло якихось очевидних полів
    if (newMapping.name === null && headers.length > 1) newMapping.name = 1
    if (newMapping.sku === null && headers.length > 0) newMapping.sku = 0
    if (newMapping.price === null && headers.length > 2) newMapping.price = 2
    if (newMapping.qty === null && headers.length > 3) newMapping.qty = 3

    setMapping(newMapping)
  }

  // Обробка вхідного тексту з Step 1
  function processRawText(text: string) {
    if (!text.trim()) {
      toast.error('Дані порожні')
      return
    }
    const sep = text.includes('\t') ? '\t' : (text.includes(';') ? ';' : ',')
    const parsed = Papa.parse<string[]>(text, { header: false, skipEmptyLines: true, delimiter: sep })
    
    if (parsed.data.length === 0) {
      toast.error('Не вдалося розпізнати жодного рядка')
      return
    }

    setRawText(text)
    setParsedRows(parsed.data)
    autoGuessMapping(parsed.data[0])
    setStep('mapping')
  }

  // Клієнтське читання текстових файлів
  function handleTextFile(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      processRawText(reader.result as string)
    }
    reader.readAsText(file, 'UTF-8')
  }

  // Клієнтське читання Excel
  async function handleExcelFile(file: File) {
    try {
      const XLSX = await import('xlsx')
      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(buffer, { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' }) as string[][]
      
      if (rows.length === 0) {
        toast.error('Файл Excel порожній')
        return
      }

      const tsv = rows.map((r) => r.map((c) => String(c ?? '')).join('\t')).join('\n')
      processRawText(tsv)
    } catch (e) {
      toast.error('Помилка читання Excel файлу')
    }
  }

  function handleFile(file: File) {
    if (!file) return
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (ext === 'xlsx' || ext === 'xls') {
      handleExcelFile(file)
    } else {
      handleTextFile(file)
    }
  }

  // Швидкий список
  function handleQuickPaste() {
    const lines = quickText.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) {
      toast.error('Введіть список товарів')
      return
    }

    // Перетворюємо у формат: Артикул \t Назва \t Ціна \t Залишок
    const simulatedRows = lines.map((line, i) => {
      const priceMatch = line.match(/(\d+(?:[.,]\d+)?)\s*(?:грн|₴|uah)?$/i)
      const price = priceMatch ? priceMatch[1].replace(',', '.') : '0'
      const name = priceMatch ? line.slice(0, line.lastIndexOf(priceMatch[1])).trim() : line
      const sku = 'AUTO-' + String(i + 1).padStart(4, '0')
      return [sku, name, price, '1']
    })

    const headers = ['Артикул', 'Назва', 'Закупівельна ціна', 'Залишок']
    const finalTable = [headers, ...simulatedRows]
    const tsv = finalTable.map((r) => r.join('\t')).join('\n')
    
    processRawText(tsv)
  }

  // Запит до backend /preview
  async function fetchPreview() {
    if (mapping.name === null) {
      toast.error('Поле "Назва" є обов\'язковим для зіставлення')
      return
    }
    if (mapping.price === null) {
      toast.error('Поле "Ціна закупівлі" є обов\'язковим для зіставлення')
      return
    }

    setLoadingPreview(true)
    setStep('preview')

    try {
      const res = await api.post('/api/v1/import/preview', {
        text: rawText,
        mapping,
        supplier_id: null,
      }) as any

      const data = res.data ?? res
      setPreviewData(data)
      
      // Перемикаємо таб прев'ю на той, який має товари
      if (data.summary.toCreate > 0) {
        setPreviewTab('create')
      } else if (data.summary.toUpdate > 0) {
        setPreviewTab('update')
      } else {
        setPreviewTab('conflicts')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка розрахунку попереднього перегляду')
      setStep('mapping')
    } finally {
      setLoadingPreview(false)
    }
  }

  // Підтвердження та виконання імпорту
  async function handleConfirmImport() {
    if (!previewData) return

    // Беремо тільки валідні товари для відправки
    const validItems = previewData.items.filter((item) => {
      // Якщо товар новий і createMissing вимкнено — пропускаємо
      if (!item.matched && !createMissing) return false
      return true
    })

    if (validItems.length === 0) {
      toast.error('Немає товарів для імпорту відповідно до обраних налаштувань')
      return
    }

    setImporting(true)
    try {
      const res = await api.post('/api/v1/import/confirm', {
        supplier_id: null,
        items: validItems.map(item => ({
          row: item.row,
          sku: item.sku,
          name: item.name,
          qty: item.qty,
          price: item.price,
          retail_price: item.retail_price,
          barcode: item.barcode,
          storage_bin: item.storage_bin,
          matched: item.matched,
          product_id: item.product_id,
          match_quality: item.match_quality,
          warnings: item.warnings,
        })),
        create_missing: createMissing,
        mode,
        update_retail: updateRetail,
      }) as any

      const result = res.data ?? res
      setImportResult(result)
      setStep('success')
      toast.success('Імпорт успішно завершено!')
      onImported()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка підтвердження імпорту')
    } finally {
      setImporting(false)
    }
  }

  function downloadTemplate() {
    const bom = '﻿'
    const blob = new Blob([bom + TEMPLATE_TSV], { type: 'text/tab-separated-values;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'import_template.tsv'; a.click()
    URL.revokeObjectURL(url)
  }

  // Рендеринг кроків
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative bg-white rounded-2xl w-full mx-4 shadow-2xl overflow-hidden flex flex-col transition-all duration-300 ${
        step === 'preview' ? 'max-w-6xl h-[90vh]' : 'max-w-3xl max-h-[85vh]'
      }`}>
        
        {/* Хедер модального вікна */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0 bg-gray-50">
          <div>
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <Upload className="text-yellow-500" size={20} />
              Покроковий імпорт товарів
            </h2>
            <div className="flex items-center gap-2 mt-1.5">
              <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${step === 'source' ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-500'}`}>1. Джерело</span>
              <ChevronRight size={12} className="text-gray-300" />
              <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${step === 'mapping' ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-500'}`}>2. Зіставлення</span>
              <ChevronRight size={12} className="text-gray-300" />
              <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${step === 'preview' ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-500'}`}>3. Попередній перегляд</span>
              <ChevronRight size={12} className="text-gray-300" />
              <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${step === 'success' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-500'}`}>4. Результат</span>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1.5 rounded-lg hover:bg-gray-200 transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Контент кроку 1: Вибір джерела */}
        {step === 'source' && (
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            <div className="flex border-b border-gray-100 bg-gray-50/50 rounded-xl p-1 shrink-0">
              {([
                { id: 'file' as Tab, icon: <FileSpreadsheet size={15} />, label: 'Файл (CSV / Excel)' },
                { id: 'paste' as Tab, icon: <Table2 size={15} />, label: 'Вставити таблицю' },
                { id: 'quick' as Tab, icon: <Clipboard size={15} />, label: 'Швидкий список' },
              ] as const).map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-semibold rounded-lg transition-all ${
                    tab === t.id ? 'bg-white text-yellow-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {t.icon} {t.label}
                </button>
              ))}
            </div>

            {tab === 'file' && (
              <div className="space-y-4">
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
                  onClick={() => fileInputRef.current?.click()}
                  className={`border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all duration-200 ${
                    dragOver ? 'border-yellow-400 bg-yellow-50/60 scale-[0.99]' : 'border-gray-200 hover:border-yellow-400 hover:bg-yellow-50/20'
                  }`}
                >
                  <div className="flex gap-4 justify-center mb-4">
                    <FileText size={44} className="text-gray-300" />
                    <FileSpreadsheet size={44} className="text-green-400 animate-pulse" />
                  </div>
                  <p className="font-semibold text-gray-700 mb-1.5 text-sm">Перетягніть файл прайс-листа або натисніть для огляду</p>
                  <p className="text-xs text-gray-400">Підтримувані формати: CSV, TSV, TXT, XLS, XLSX</p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.tsv,.txt,.xls,.xlsx"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
                    className="hidden"
                  />
                </div>
                
                <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 flex gap-3 text-xs text-blue-800">
                  <Info size={16} className="text-blue-500 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold">Порада:</span> Великі прайси краще завантажувати файлом Excel або CSV. Перший рядок бажано відвести під назви колонок для автоматичного розпізнавання.
                  </div>
                </div>

                <button
                  onClick={downloadTemplate}
                  className="flex items-center justify-center gap-2 w-full text-xs font-semibold text-blue-600 hover:text-blue-700 px-4 py-3 border border-blue-200 rounded-xl hover:bg-blue-50/50 transition-colors"
                >
                  <Download size={14} /> Завантажити зразок таблиці шаблону імпорту
                </button>
              </div>
            )}

            {tab === 'paste' && (
              <div className="space-y-4">
                <div className="text-xs text-gray-500">
                  Скопіюйте таблицю прямо з вашої таблиці Excel чи Google Sheets та вставте її в поле нижче:
                </div>
                <textarea
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  placeholder={"Артикул\tНазва\tЦіна\tЗалишок\tШтрихкод\nW712\tФільтр оливний Mann\t220.00\t15\t4011558737604\nB005\tМасло 5W-40\t450.00\t8\t4047024367612"}
                  rows={10}
                  autoFocus
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-yellow-400 focus:border-transparent resize-none bg-gray-50/50"
                />
                <button
                  disabled={!rawText.trim()}
                  onClick={() => processRawText(rawText)}
                  className="w-full py-3 bg-yellow-400 text-black font-bold rounded-xl hover:bg-yellow-300 disabled:opacity-40 transition-colors flex items-center justify-center gap-2 text-xs"
                >
                  Розпізнати дані ({rawText.split('\n').filter(Boolean).length} рядків) →
                </button>
              </div>
            )}

            {tab === 'quick' && (
              <div className="space-y-4">
                <div className="text-xs text-gray-500 leading-relaxed">
                  Введіть простий список товарів (по одному на рядок). Ви можете вказати ціну в кінці кожного рядка:
                </div>
                <textarea
                  value={quickText}
                  onChange={(e) => setQuickText(e.target.value)}
                  placeholder={"Гальмівні колодки Brembo 950\nФільтр повітряний Mann 350 грн\nМоторна олива Bosch 5W-30 420\nСвічки запалювання NGK"}
                  rows={10}
                  autoFocus
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-xs focus:outline-none focus:ring-2 focus:ring-yellow-400 focus:border-transparent resize-none bg-gray-50/50"
                />
                <button
                  disabled={!quickText.trim()}
                  onClick={handleQuickPaste}
                  className="w-full py-3 bg-yellow-400 text-black font-bold rounded-xl hover:bg-yellow-300 disabled:opacity-40 transition-colors flex items-center justify-center gap-2 text-xs"
                >
                  Згенерувати таблицю та перейти до мапінгу →
                </button>
              </div>
            )}
          </div>
        )}

        {/* Контент кроку 2: Зіставлення колонок */}
        {step === 'mapping' && (
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <div className="bg-yellow-50/50 border border-yellow-100 rounded-xl p-4 text-xs text-yellow-800">
              Система розпізнала перші рядки вашого файлу. Вкажіть, які саме колонки відповідають полям каталогу товарів.
            </div>

            {/* Блок селекторів мапінгу */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {([
                { field: 'sku' as keyof ColumnMapping, label: 'Артикул (SKU)', required: false, icon: '📋' },
                { field: 'name' as keyof ColumnMapping, label: 'Назва товару', required: true, icon: '🏷️' },
                { field: 'price' as keyof ColumnMapping, label: 'Ціна закупівлі', required: true, icon: '💰' },
                { field: 'retail_price' as keyof ColumnMapping, label: 'Роздрібна ціна', required: false, icon: '🛒' },
                { field: 'qty' as keyof ColumnMapping, label: 'Залишок (кількість)', required: false, icon: '📦' },
                { field: 'barcode' as keyof ColumnMapping, label: 'Штрихкод', required: false, icon: '⚡' },
                { field: 'storage_bin' as keyof ColumnMapping, label: 'Комірка зберігання', required: false, icon: '📍' },
              ]).map((fieldItem) => {
                const currentValue = mapping[fieldItem.field];
                return (
                  <div key={fieldItem.field} className="bg-gray-50 border border-gray-100 rounded-xl p-3 flex flex-col justify-between space-y-2">
                    <label className="text-xs font-bold text-gray-700 flex items-center gap-1.5">
                      <span>{fieldItem.icon}</span>
                      {fieldItem.label}
                      {fieldItem.required && <span className="text-red-500 font-bold">*</span>}
                    </label>
                    <select
                      value={currentValue !== null ? String(currentValue) : ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        setMapping(prev => ({
                          ...prev,
                          [fieldItem.field]: val === '' ? null : parseInt(val)
                        }));
                      }}
                      className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                    >
                      <option value="">-- Не імпортувати --</option>
                      {parsedRows[0]?.map((colName, index) => (
                        <option key={index} value={index}>
                          Колонка {index + 1}: {colName.slice(0, 30) || `(Без назви)`}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>

            {/* Попередній перегляд таблиці */}
            <div className="space-y-2">
              <h3 className="text-xs font-bold text-gray-800 uppercase tracking-wide">Перші 5 рядків для перевірки:</h3>
              <div className="border border-gray-100 rounded-xl overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-100 text-gray-500 font-semibold">
                      {parsedRows[0]?.map((_, index) => {
                        // Визначаємо яка це колонка в мапінгу
                        const matchedFields: string[] = []
                        Object.entries(mapping).forEach(([key, val]) => {
                          if (val === index) matchedFields.push(key)
                        })

                        return (
                          <th key={index} className="px-3 py-2 border-r border-gray-100 text-center min-w-[120px]">
                            <div className="font-mono text-[10px] text-gray-400">Кол. {index + 1}</div>
                            {matchedFields.length > 0 ? (
                              <div className="mt-1 inline-block bg-yellow-100 text-yellow-800 text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider">
                                {matchedFields.join(', ')}
                              </div>
                            ) : (
                              <div className="mt-1 inline-block bg-gray-200 text-gray-500 text-[10px] px-2 py-0.5 rounded-full uppercase">
                                Пропущено
                              </div>
                            )}
                          </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {parsedRows.slice(0, 5).map((row, rIndex) => (
                      <tr key={rIndex} className={rIndex === 0 ? 'bg-gray-50/30 italic text-gray-400' : 'hover:bg-gray-50/20'}>
                        {row.map((cell, cIndex) => (
                          <td key={cIndex} className="px-3 py-2 border-r border-gray-100 font-medium truncate max-w-[200px]">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Кнопки навігації */}
            <div className="flex gap-3 justify-end shrink-0 pt-4 border-t border-gray-100">
              <button
                onClick={() => setStep('source')}
                className="px-4 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-semibold rounded-xl transition-colors"
              >
                Назад
              </button>
              <button
                onClick={fetchPreview}
                className="px-6 py-2.5 bg-yellow-400 hover:bg-yellow-300 text-black font-bold text-xs rounded-xl transition-colors flex items-center gap-1.5"
              >
                Розрахувати попередній перегляд →
              </button>
            </div>
          </div>
        )}

        {/* Контент кроку 3: Попередній перегляд (Dry-run) */}
        {step === 'preview' && (
          <>
            {loadingPreview ? (
              <div className="flex-1 flex flex-col items-center justify-center p-12 space-y-4">
                <div className="w-12 h-12 border-4 border-yellow-400 border-t-transparent rounded-full animate-spin" />
                <p className="text-sm font-semibold text-gray-700">Опрацьовуємо прайс-лист та шукаємо збіги в каталозі...</p>
                <p className="text-xs text-gray-400">Це може зайняти кілька секунд</p>
              </div>
            ) : previewData ? (
              <div className="flex-1 flex flex-col overflow-hidden">
                
                {/* Панель налаштувань імпорту */}
                <div className="bg-gray-50 border-b border-gray-100 px-6 py-3 shrink-0 flex flex-wrap items-center gap-4 text-xs font-semibold">
                  <div className="flex items-center gap-1.5">
                    <span className="text-gray-500">Режим залишків:</span>
                    <select
                      value={mode}
                      onChange={(e) => setMode(e.target.value as 'replace' | 'add')}
                      className="border border-gray-200 rounded-lg px-2 py-1 bg-white font-bold"
                    >
                      <option value="replace">Замінити поточні залишки</option>
                      <option value="add">Додати до поточних залишків</option>
                    </select>
                  </div>

                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={updateRetail}
                        onChange={(e) => setUpdateRetail(e.target.checked)}
                        className="rounded text-yellow-500 focus:ring-yellow-400"
                      />
                      <span>Оновлювати роздрібну ціну</span>
                    </label>

                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={createMissing}
                        onChange={(e) => setCreateMissing(e.target.checked)}
                        className="rounded text-yellow-500 focus:ring-yellow-400"
                      />
                      <span>Створювати нові товари (відсутні в базі)</span>
                    </label>
                  </div>
                </div>

                {/* Вкладки статистики */}
                <div className="flex border-b border-gray-100 shrink-0">
                  <button
                    onClick={() => setPreviewTab('create')}
                    className={`flex-1 py-3 text-xs font-bold text-center border-b-2 transition-all flex items-center justify-center gap-2 ${
                      previewTab === 'create'
                        ? 'border-yellow-400 text-yellow-700 bg-yellow-50/20'
                        : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    <span>🆕 Створення нових</span>
                    <span className="bg-blue-100 text-blue-800 text-[10px] px-2 py-0.5 rounded-full font-bold">
                      {previewData.summary.toCreate}
                    </span>
                  </button>

                  <button
                    onClick={() => setPreviewTab('update')}
                    className={`flex-1 py-3 text-xs font-bold text-center border-b-2 transition-all flex items-center justify-center gap-2 ${
                      previewTab === 'update'
                        ? 'border-yellow-400 text-yellow-700 bg-yellow-50/20'
                        : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    <span>🔄 Оновлення існуючих</span>
                    <span className="bg-yellow-100 text-yellow-800 text-[10px] px-2 py-0.5 rounded-full font-bold">
                      {previewData.summary.toUpdate}
                    </span>
                  </button>

                  <button
                    onClick={() => setPreviewTab('conflicts')}
                    className={`flex-1 py-3 text-xs font-bold text-center border-b-2 transition-all flex items-center justify-center gap-2 ${
                      previewTab === 'conflicts'
                        ? 'border-yellow-400 text-yellow-700 bg-yellow-50/20'
                        : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    <span>⚠️ Пропущено (Помилки/Конфлікти)</span>
                    <span className="bg-red-100 text-red-800 text-[10px] px-2 py-0.5 rounded-full font-bold">
                      {previewData.summary.conflicts}
                    </span>
                  </button>
                </div>

                {/* Основний вміст вкладки попереднього перегляду */}
                <div className="flex-1 overflow-auto">
                  {previewTab === 'create' && (
                    <div className="min-w-full">
                      {previewData.items.filter((i) => !i.matched).length === 0 ? (
                        <div className="p-12 text-center text-gray-400 text-xs font-medium">
                          Не виявлено нових товарів для створення.
                        </div>
                      ) : (
                        <table className="w-full text-xs text-left border-collapse">
                          <thead className="bg-gray-50 border-b border-gray-100 sticky top-0 font-bold text-gray-600">
                            <tr>
                              <th className="px-4 py-2 w-12 text-center">Рядок</th>
                              <th className="px-4 py-2 w-40">Артикул (SKU)</th>
                              <th className="px-4 py-2">Назва</th>
                              <th className="px-4 py-2 w-32 text-right">Закупка</th>
                              <th className="px-4 py-2 w-32 text-right">Роздріб (імпорт)</th>
                              <th className="px-4 py-2 w-28 text-right">Залишок</th>
                              <th className="px-4 py-2 w-32">Комірка / Штрихкод</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {previewData.items
                              .filter((i) => !i.matched)
                              .map((item) => (
                                <tr key={item.row} className="hover:bg-gray-50/50">
                                  <td className="px-4 py-2.5 text-center text-gray-400 font-mono">{item.row}</td>
                                  <td className="px-4 py-2.5 font-mono text-gray-800 font-semibold">{item.sku || '(Буде згенеровано)'}</td>
                                  <td className="px-4 py-2.5 font-medium text-gray-900">{item.name}</td>
                                  <td className="px-4 py-2.5 text-right font-semibold text-gray-800">
                                    {(item.price / 100).toFixed(2)} грн
                                  </td>
                                  <td className="px-4 py-2.5 text-right font-semibold text-blue-600">
                                    {item.retail_price ? `${(item.retail_price / 100).toFixed(2)} грн` : 'Авто'}
                                  </td>
                                  <td className="px-4 py-2.5 text-right text-gray-600 font-bold">+{item.qty} шт</td>
                                  <td className="px-4 py-2.5 text-xs text-gray-500">
                                    {item.storage_bin && <div className="text-gray-800">📍 {item.storage_bin}</div>}
                                    {item.barcode && <div>⚡ {item.barcode}</div>}
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}

                  {previewTab === 'update' && (
                    <div className="min-w-full">
                      {previewData.items.filter((i) => i.matched).length === 0 ? (
                        <div className="p-12 text-center text-gray-400 text-xs font-medium">
                          Не знайдено товарів для оновлення.
                        </div>
                      ) : (
                        <table className="w-full text-xs text-left border-collapse">
                          <thead className="bg-gray-50 border-b border-gray-100 sticky top-0 font-bold text-gray-600">
                            <tr>
                              <th className="px-4 py-2 w-12 text-center">Рядок</th>
                              <th className="px-4 py-2 w-32">Артикул</th>
                              <th className="px-4 py-2">Назва (Співпадіння)</th>
                              <th className="px-4 py-2 w-32 text-right">Собівартість</th>
                              <th className="px-4 py-2 w-36 text-right">Роздрібна ціна</th>
                              <th className="px-4 py-2 w-32 text-right">Залишок на складі</th>
                              <th className="px-4 py-2 w-28">Тип збігу</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {previewData.items
                              .filter((i) => i.matched)
                              .map((item) => {
                                const priceDiff = item.price - (item.old_price ?? 0)
                                const isPriceChanged = priceDiff !== 0

                                // Розрахунок нового залишку залежно від режиму
                                const oldQty = item.old_qty ?? 0
                                const importQty = item.qty
                                const finalQty = mode === 'add' ? oldQty + importQty : importQty
                                const isQtyChanged = oldQty !== finalQty

                                return (
                                  <tr key={item.row} className="hover:bg-gray-50/50">
                                    <td className="px-4 py-2.5 text-center text-gray-400 font-mono">{item.row}</td>
                                    <td className="px-4 py-2.5 font-mono text-gray-700">{item.sku}</td>
                                    <td className="px-4 py-2.5 font-medium">
                                      <div className="text-gray-900">{item.name}</div>
                                      {item.warnings.map((w, idx) => (
                                        <div key={idx} className="text-[10px] text-yellow-600 font-semibold flex items-center gap-1 mt-0.5">
                                          <span>⚠️</span> {w}
                                        </div>
                                      ))}
                                    </td>
                                    {/* Ціна закупівлі */}
                                    <td className="px-4 py-2.5 text-right font-medium">
                                      <div className="text-gray-400">{(item.old_price ? item.old_price / 100 : 0).toFixed(2)}</div>
                                      <div className={`flex items-center justify-end gap-1.5 font-bold ${
                                        !isPriceChanged ? 'text-gray-700' : priceDiff > 0 ? 'text-red-600' : 'text-green-600'
                                      }`}>
                                        <ArrowRight size={10} className="text-gray-300" />
                                        <span>{(item.price / 100).toFixed(2)}</span>
                                      </div>
                                    </td>
                                    {/* Роздрібна ціна */}
                                    <td className="px-4 py-2.5 text-right font-medium">
                                      <div className="text-gray-400">{(item.old_retail_price ? item.old_retail_price / 100 : 0).toFixed(2)}</div>
                                      <div className="flex items-center justify-end gap-1.5 font-bold text-gray-700">
                                        <ArrowRight size={10} className="text-gray-300" />
                                        <span>
                                          {!updateRetail
                                            ? (item.old_retail_price ? (item.old_retail_price / 100).toFixed(2) : '—')
                                            : item.retail_price
                                              ? (item.retail_price / 100).toFixed(2)
                                              : 'Авто'}
                                        </span>
                                      </div>
                                    </td>
                                    {/* Залишок */}
                                    <td className="px-4 py-2.5 text-right font-medium">
                                      <div className="text-gray-400">{oldQty} шт</div>
                                      <div className={`flex items-center justify-end gap-1.5 font-bold ${
                                        isQtyChanged ? 'text-blue-600' : 'text-gray-700'
                                      }`}>
                                        <ArrowRight size={10} className="text-gray-300" />
                                        <span>{finalQty} шт</span>
                                      </div>
                                    </td>
                                    {/* Якість збігу */}
                                    <td className="px-4 py-2.5 font-semibold text-[10px] uppercase">
                                      <span className={`px-2 py-0.5 rounded-full ${
                                        item.match_quality === 'exact' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
                                      }`}>
                                        {item.match_quality === 'exact' ? 'Точний' : 'Неточний'}
                                      </span>
                                    </td>
                                  </tr>
                                )
                              })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}

                  {previewTab === 'conflicts' && (
                    <div className="min-w-full">
                      {previewData.conflicts.length === 0 ? (
                        <div className="p-12 text-center text-gray-400 text-xs font-medium">
                          Конфліктів або помилок не знайдено. Всі рядки придатні для завантаження!
                        </div>
                      ) : (
                        <table className="w-full text-xs text-left border-collapse">
                          <thead className="bg-gray-50 border-b border-gray-100 sticky top-0 font-bold text-gray-600">
                            <tr>
                              <th className="px-4 py-2 w-16 text-center">Рядок</th>
                              <th className="px-4 py-2 w-32">Артикул (якщо є)</th>
                              <th className="px-4 py-2">Назва товару (якщо є)</th>
                              <th className="px-4 py-2 text-red-600">Причина відхилення</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {previewData.conflicts.map((conflict, index) => (
                              <tr key={index} className="bg-red-50/20 hover:bg-red-50/40">
                                <td className="px-4 py-2.5 text-center text-red-500 font-bold font-mono">{conflict.row}</td>
                                <td className="px-4 py-2.5 font-mono text-gray-400">{conflict.sku || '—'}</td>
                                <td className="px-4 py-2.5 text-gray-700 font-medium">{conflict.name || '—'}</td>
                                <td className="px-4 py-2.5 text-red-600 font-bold flex items-center gap-1.5">
                                  <AlertCircle size={12} className="shrink-0" />
                                  <span>{conflict.reason}</span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </div>

                {/* Футер кроку 3 */}
                <div className="flex items-center gap-3 px-6 py-4 border-t border-gray-100 bg-gray-50 shrink-0">
                  <div className="flex-1 text-xs text-gray-500 leading-normal">
                    Знайдено <span className="font-bold text-gray-900">{previewData.items.length}</span> валідних рядків, з них: 
                    <span className="text-blue-600 font-bold ml-1">{createMissing ? previewData.summary.toCreate : 0}</span> до створення, 
                    <span className="text-yellow-600 font-bold ml-1">{previewData.summary.toUpdate}</span> до оновлення.
                    {previewData.summary.conflicts > 0 && (
                      <span className="text-red-500 font-bold ml-1">{previewData.summary.conflicts} буде пропущено.</span>
                    )}
                  </div>
                  <button
                    onClick={() => setStep('mapping')}
                    className="px-4 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-semibold rounded-xl transition-colors"
                  >
                    Назад до мапінгу
                  </button>
                  <button
                    onClick={handleConfirmImport}
                    disabled={importing || (previewData.items.length === 0)}
                    className="px-6 py-2.5 bg-yellow-400 hover:bg-yellow-300 text-black font-bold text-xs rounded-xl disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-1.5"
                  >
                    {importing ? (
                      <><div className="w-3.5 h-3.5 border-2 border-black border-t-transparent rounded-full animate-spin" /> Записуємо в базу...</>
                    ) : (
                      <>Запустити імпорт →</>
                    )}
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}

        {/* Контент кроку 4: Результат / Успіх */}
        {step === 'success' && importResult && (
          <div className="flex-1 overflow-y-auto p-8 space-y-6 flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 bg-green-50 border border-green-200 text-green-500 rounded-full flex items-center justify-center shadow-inner animate-bounce">
              <CheckCircle2 size={36} />
            </div>

            <div className="space-y-2 max-w-md">
              <h3 className="text-xl font-bold text-gray-900">Імпорт завершено успішно!</h3>
              <p className="text-xs text-gray-500">
                Запит на оновлення каталогу товарів успішно оброблено базою даних.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-4 w-full max-w-sm bg-gray-50 border border-gray-100 rounded-2xl p-4 text-center">
              <div className="space-y-1">
                <div className="text-[10px] text-gray-400 uppercase font-semibold">Створено</div>
                <div className="text-xl font-extrabold text-blue-600">{importResult.created}</div>
                <div className="text-[9px] text-gray-400">нових товарів</div>
              </div>
              <div className="space-y-1 border-x border-gray-200">
                <div className="text-[10px] text-gray-400 uppercase font-semibold">Оновлено</div>
                <div className="text-xl font-extrabold text-yellow-600">{importResult.updated}</div>
                <div className="text-[9px] text-gray-400">змінено картки</div>
              </div>
              <div className="space-y-1">
                <div className="text-[10px] text-gray-400 uppercase font-semibold">Помилок</div>
                <div className="text-xl font-extrabold text-red-500">{importResult.errors}</div>
                <div className="text-[9px] text-gray-400">відхилено рядків</div>
              </div>
            </div>

            <button
              onClick={onClose}
              className="px-8 py-3 bg-yellow-400 hover:bg-yellow-300 text-black font-bold text-xs rounded-xl shadow-md transition-all hover:scale-[1.02]"
            >
              Закрити вікно
            </button>
          </div>
        )}

      </div>
    </div>
  )
}
