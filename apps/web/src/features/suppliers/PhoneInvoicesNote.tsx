import { useEffect, useRef, useState } from 'react'
import { Smartphone } from 'lucide-react'
import { toast } from '@/components/ui/Toast'
import { formatMoney } from '@/lib/utils'
import { openAiInvoiceDraft } from '@/features/ai/openAiInvoiceDraft'
import { PHONE_INVOICE_EVENT, listPhoneInvoices, phoneInvoiceAction, phoneInvoiceGaps, phoneInvoiceTotal, removePhoneInvoice, type PhoneInvoiceEntry } from '@/features/tillCommands/phoneInvoiceModel'

/** Один сталий ключ для всіх працівників каси: хто б не відкрив накладну, це та сама чернетка, а не друга. */
const PHONE_INVOICE_SCOPE = 'phone-invoice'

/**
 * «Вхідні» каси: накладні, надіслані з телефона (етап 8, 22.11.2026). Тут нічого не проводиться —
 * «Відкрити» створює звичайну чернетку приходу, де людина перевіряє рядки й сама натискає «Провести».
 */
export function PhoneInvoicesNote({ onOpen }: { onOpen: (path: string) => void }) {
  const [entries, setEntries] = useState<PhoneInvoiceEntry[]>(() => listPhoneInvoices())
  const [busy, setBusy] = useState('')
  const [confirming, setConfirming] = useState('')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    const refresh = () => setEntries(listPhoneInvoices())
    window.addEventListener(PHONE_INVOICE_EVENT, refresh)
    return () => { alive.current = false; window.removeEventListener(PHONE_INVOICE_EVENT, refresh) }
  }, [])
  if (!entries.length) return null

  async function open(entry: PhoneInvoiceEntry) {
    if (busy) return
    setBusy(entry.operation_id)
    try {
      const path = await openAiInvoiceDraft(phoneInvoiceAction(entry), PHONE_INVOICE_SCOPE, () => { if (!alive.current) throw new Error('Екран закрито. Відкрийте накладну ще раз.') })
      onOpen(path)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося відкрити накладну з телефона')
    } finally { if (alive.current) setBusy('') }
  }
  function remove(entry: PhoneInvoiceEntry) {
    removePhoneInvoice(entry.operation_id)
    setConfirming('')
    setEntries(listPhoneInvoices())
  }
  const time = (value: string) => new Date(value).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

  return (
    <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-blue-900"><Smartphone size={16} />З телефона: {entries.length}</p>
      <ul className="mt-2 space-y-2">
        {entries.map(entry => {
          const gaps = phoneInvoiceGaps(entry.rows)
          const label = [entry.supplier_name, entry.invoice_number ? '№ ' + entry.invoice_number : ''].filter(Boolean).join(' ') || 'Накладна без постачальника'
          return (
            <li key={entry.operation_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 text-sm">
              <span>
                <span className="font-medium text-gray-900">{label}</span>
                <span className="block text-xs text-gray-500">
                  рядків: {entry.rows.length} · {formatMoney(phoneInvoiceTotal(entry.rows))} · надіслано {time(entry.received_at)}{entry.author ? ' · ' + entry.author : ''}
                  {gaps > 0 && <span className="text-amber-700"> · без кількості або ціни: {gaps}</span>}
                </span>
              </span>
              <span className="flex items-center gap-2">
                {confirming === entry.operation_id ? (
                  <>
                    <span className="text-xs text-red-700">Прибрати зі списку? Чернетка приходу, якщо її вже відкривали, лишиться.</span>
                    <button type="button" onClick={() => remove(entry)} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white">Так, прибрати</button>
                    <button type="button" onClick={() => setConfirming('')} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs">Ні</button>
                  </>
                ) : (
                  <>
                    <button type="button" disabled={Boolean(busy)} onClick={() => { void open(entry) }}
                      aria-label={`Відкрити накладну з телефона: ${label}`} className="rounded-lg bg-yellow-400 px-3 py-1.5 text-xs font-semibold text-gray-900 hover:bg-yellow-300 disabled:opacity-50">
                      {busy === entry.operation_id ? 'Відкриваю…' : 'Відкрити'}
                    </button>
                    <button type="button" disabled={Boolean(busy)} onClick={() => setConfirming(entry.operation_id)}
                      aria-label={`Прибрати накладну з телефона: ${label}`} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-600 disabled:opacity-50">Прибрати</button>
                  </>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="mt-2 text-xs text-blue-900">Залишки зміняться лише після «Провести» у відкритій накладній. Після проведення приберіть запис звідси.</p>
    </div>
  )
}
