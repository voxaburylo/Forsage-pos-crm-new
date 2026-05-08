import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { returnApi } from './returnApi'
import { saleApi } from './saleApi'
import type { ReturnReason, RefundMethod } from '@/types/return'
import { RETURN_REASON_LABELS, REFUND_METHOD_LABELS } from '@/types/return'
import { Layout } from '@/components/Layout'
import { Button, Card, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'

const REASONS = Object.entries(RETURN_REASON_LABELS) as [ReturnReason, string][]
const METHODS  = Object.entries(REFUND_METHOD_LABELS) as [RefundMethod, string][]

interface FoundSale { id: string; sale_number: string; total: number; status: string }

export default function ReturnForm() {
  const [saleNumber, setSaleNumber] = useState('')
  const [found, setFound]           = useState<FoundSale | null>(null)
  const [reason, setReason]         = useState<ReturnReason>('defective')
  const [reasonNote, setReasonNote] = useState('')
  const [method, setMethod]         = useState<RefundMethod>('cash')
  const [searching, setSearching]   = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone]             = useState(false)

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!saleNumber.trim()) return
    setSearching(true)
    setFound(null)
    try {
      const result = await saleApi.list({ sale_number: saleNumber.trim() })
      const sale = (result as unknown as { data: FoundSale[] }).data?.[0] ?? null
      if (!sale) { toast.error('Чек не знайдено'); return }
      setFound(sale)
    } catch {
      toast.error('Помилка пошуку чека')
    } finally {
      setSearching(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!found) return
    if (found.status === 'returned') { toast.error('Цей чек вже повернуто'); return }
    if (reason === 'other' && !reasonNote.trim()) { toast.error('Уточніть причину'); return }

    setSubmitting(true)
    try {
      await returnApi.create(found.id, reason, method, reasonNote || undefined)
      toast.success('Повернення оформлено')
      setDone(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка оформлення повернення')
    } finally {
      setSubmitting(false)
    }
  }

  function reset() {
    setDone(false); setFound(null); setSaleNumber('')
    setReason('defective'); setReasonNote(''); setMethod('cash')
  }

  if (done) {
    return (
      <Layout title="Повернення">
        <Card className="max-w-md text-center py-10">
          <RotateCcw size={40} className="text-green-500 mx-auto mb-3" />
          <p className="text-lg font-semibold text-gray-900 mb-1">Повернення оформлено</p>
          <p className="text-gray-500 text-sm mb-6">
            Товар повернуто на склад. {REFUND_METHOD_LABELS[method]}.
          </p>
          <Button onClick={reset}>Нове повернення</Button>
        </Card>
      </Layout>
    )
  }

  return (
    <Layout title="Оформити повернення">
      <div className="max-w-lg space-y-4">

        {/* Крок 1: знайти чек */}
        <Card>
          <h3 className="font-semibold text-gray-800 mb-3">Крок 1 — Знайдіть чек</h3>
          <form onSubmit={handleSearch} className="flex gap-3">
            <Input
              value={saleNumber}
              onChange={(e) => setSaleNumber(e.target.value)}
              placeholder="Номер чека (напр. 000001)"
              className="flex-1"
              autoFocus
            />
            <Button type="submit" loading={searching} variant="secondary">Знайти</Button>
          </form>

          {found && (
            <div className={`mt-3 rounded-xl px-4 py-3 border text-sm font-medium ${
              found.status === 'returned'
                ? 'bg-red-50 border-red-200 text-red-700'
                : 'bg-green-50 border-green-200 text-green-700'
            }`}>
              {found.status === 'returned'
                ? '⛔ Цей чек вже повернуто'
                : `✓ Чек #${found.sale_number} — сума: ${formatMoney(found.total)}`}
            </div>
          )}
        </Card>

        {/* Крок 2: причина і метод */}
        {found && found.status !== 'returned' && (
          <Card>
            <form onSubmit={handleSubmit} className="space-y-5">
              <h3 className="font-semibold text-gray-800">Крок 2 — Причина і метод</h3>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Причина *</label>
                <div className="space-y-2">
                  {REASONS.map(([value, label]) => (
                    <label key={value} className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                      reason === value ? 'bg-yellow-50 border-yellow-400' : 'border-gray-200 hover:border-gray-300'
                    }`}>
                      <input type="radio" name="reason" value={value}
                        checked={reason === value} onChange={() => setReason(value)}
                        className="accent-yellow-500" />
                      <span className="text-sm text-gray-800">{label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {reason === 'other' && (
                <Input label="Уточніть причину *" value={reasonNote}
                  onChange={(e) => setReasonNote(e.target.value)}
                  placeholder="Опишіть причину повернення..." required />
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Повернення коштів *</label>
                <div className="space-y-2">
                  {METHODS.map(([value, label]) => (
                    <label key={value} className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                      method === value ? 'bg-yellow-50 border-yellow-400' : 'border-gray-200 hover:border-gray-300'
                    }`}>
                      <input type="radio" name="method" value={value}
                        checked={method === value} onChange={() => setMethod(value)}
                        className="accent-yellow-500" />
                      <span className="text-sm text-gray-800">{label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <Button type="submit" loading={submitting} icon={<RotateCcw size={16} />} className="w-full">
                Оформити повернення на {formatMoney(found.total)}
              </Button>
            </form>
          </Card>
        )}
      </div>
    </Layout>
  )
}
