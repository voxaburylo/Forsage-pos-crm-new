import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { importApi } from './importApi'
import type { ParseResult } from './importApi'
import { supplierApi } from './supplierApi'
import { toast } from '@/components/ui/Toast'

export type Step = 'paste' | 'review'
export type PriceStrategy = 'grid' | 'percent' | 'manual'

export function useImportPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('paste')
  const [text, setText] = useState('')
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
    priceStrategy,
    setPriceStrategy,
    customMarkupPct,
    setCustomMarkupPct,
    manualPrices,
    setManualPrices,
    handleParse,
    handleConfirm,
    matched,
    notFound,
    fuzzy,
    totalKop,
    navigate
  }
}
