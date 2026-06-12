import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { importApi } from './importApi'
import type { ParseResult } from './importApi'
import { supplierApi } from './supplierApi'
import { toast } from '@/components/ui/Toast'
import Papa from 'papaparse'

export type Step = 'paste' | 'mapping' | 'review'
export type PriceStrategy = 'grid' | 'percent' | 'manual'

export interface ColumnMapping {
  sku: number | null
  name: number | null
  qty: number | null
  price: number | null
  retail_price?: number | null
  barcode?: number | null
  storage_bin?: number | null
}

export function useImportPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('paste')
  const [text, setText] = useState('')
  const [parsedRows, setParsedRows] = useState<string[][]>([])
  const [rawText, setRawText] = useState('')
  const [mapping, setMapping] = useState<ColumnMapping>({
    sku: null,
    name: null,
    qty: null,
    price: null,
  })

  const [supplierId, setSupplierId] = useState('')
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [createMissing, setCreateMissing] = useState(false)
  const [result, setResult] = useState<ParseResult | null>(null)
  const [parsing, setParsing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])
  const [priceStrategy, setPriceStrategy] = useState<PriceStrategy>('grid')
  const [customMarkupPct, setCustomMarkupPct] = useState('30')
  const [manualPrices, setManualPrices] = useState<Record<number, string>>({})

  useEffect(() => {
    supplierApi.list({ per_page: 200 }).then((r) => setSuppliers(r.data)).catch(() => {})
  }, [])

  function autoGuessMapping(headers: string[]) {
    const newMapping: ColumnMapping = {
      sku: null,
      name: null,
      qty: null,
      price: null,
    }

    headers.forEach((h, index) => {
      const header = h.toLowerCase().trim()
      if (/артикул|sku|article|код|арт/i.test(header) && newMapping.sku === null) {
        newMapping.sku = index
      } else if (/назва|name|товар|product|наименование|описание/i.test(header) && newMapping.name === null) {
        newMapping.name = index
      } else if (/закупівельна|собівартість|purchase|buy.?price|цена.закупки/i.test(header) && newMapping.price === null) {
        newMapping.price = index
      } else if (/залишок|stock|qty|quantity|к-сть|кол|кількість/i.test(header) && newMapping.qty === null) {
        newMapping.qty = index
      }
    })

    // Fallbacks
    if (newMapping.name === null && headers.length > 1) newMapping.name = 1
    if (newMapping.sku === null && headers.length > 0) newMapping.sku = 0
    if (newMapping.price === null && headers.length > 2) newMapping.price = 2
    if (newMapping.qty === null && headers.length > 3) newMapping.qty = 3

    setMapping(newMapping)
  }

  function processRawText(textVal: string) {
    if (!textVal.trim()) {
      toast.error('Дані порожні')
      return
    }
    const sep = textVal.includes('\t') ? '\t' : (textVal.includes(';') ? ';' : ',')
    const parsed = Papa.parse<string[]>(textVal, { header: false, skipEmptyLines: true, delimiter: sep })
    
    if (parsed.data.length === 0) {
      toast.error('Не вдалося розпізнати жодного рядка')
      return
    }

    setRawText(textVal)
    setParsedRows(parsed.data)
    autoGuessMapping(parsed.data[0])
    setStep('mapping')
  }

  // Handle file import
  async function handleFile(file: File) {
    const ext = file.name.split('.').pop()?.toLowerCase()
    
    if (ext === 'xlsx' || ext === 'xls') {
      setParsing(true)
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
      } finally {
        setParsing(false)
      }
    } else {
      // Text / CSV
      const reader = new FileReader()
      reader.onload = () => {
        processRawText(reader.result as string)
      }
      reader.readAsText(file, 'UTF-8')
    }
  }

  // Confirm mapping and parse via backend preview API
  async function handlePreview() {
    if (mapping.name === null) { toast.error('Вкажіть колонку для Назви'); return }
    if (mapping.price === null) { toast.error('Вкажіть колонку для Ціни'); return }
    if (mapping.qty === null) { toast.error('Вкажіть колонку для Кількості'); return }

    setParsing(true)
    try {
      const res = await importApi.preview({
        text: rawText,
        mapping: {
          sku: mapping.sku,
          name: mapping.name,
          qty: mapping.qty,
          price: mapping.price,
        },
        supplier_id: supplierId || null,
      })

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

  const matched    = result?.items.filter((i) => i.matched)        ?? []
  const notFound   = result?.items.filter((i) => !i.matched)       ?? []
  const fuzzy      = matched.filter((i) => i.match_quality === 'fuzzy')
  const totalKop   = matched.reduce((s, i) => s + i.qty * i.price, 0)

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

  return {
    step,
    setStep,
    text,
    setText,
    parsedRows,
    setParsedRows,
    rawText,
    setRawText,
    mapping,
    setMapping,
    supplierId,
    setSupplierId,
    invoiceNumber,
    setInvoiceNumber,
    createMissing,
    setCreateMissing,
    result,
    setResult,
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
    navigate
  }
}
