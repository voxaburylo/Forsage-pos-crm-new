import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { UserPlus } from 'lucide-react'
import { Button, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { desktopBridge } from '@/lib/desktopBridge'
import { CAMERA_SCAN_EVENT } from '@/lib/cameraScan'
import { customerApi } from '@/features/customers/customerApi'
import { FREE_CARD_EVENT, cardCodeFromParam, newCustomerWithCardPath } from '@/features/customers/cardBatchModel'

type Found = { id: string; full_name: string | null; phone: string | null }

/**
 * План B2 (23.11.2026): на касі вперше відсканували картку з виданої пачки — вона ще нічия.
 * Програма пропонує прив'язати її до клієнта: знайти наявного або створити нового.
 */
export function FreeCardModal() {
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<Found[] | null>(null)
  const [busy, setBusy] = useState(false)
  /** У клієнта вже є інша картка: питаємо, чи замінити, — не затираємо мовчки. */
  const [replacing, setReplacing] = useState<{ customer: Found; oldCard: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onFreeCard = (event: Event) => {
      const next = cardCodeFromParam((event as CustomEvent<{ code?: string }>).detail?.code)
      if (!next) return
      setCode(next); setSearch(''); setRows(null); setReplacing(null)
    }
    window.addEventListener(FREE_CARD_EVENT, onFreeCard)
    return () => window.removeEventListener(FREE_CARD_EVENT, onFreeCard)
  }, [])

  useEffect(() => { if (code) inputRef.current?.focus() }, [code])

  useEffect(() => {
    const query = search.trim()
    if (!code || query.length < 2) { setRows(null); return }
    let active = true
    const timer = window.setTimeout(() => {
      const lookup = desktopBridge()?.pos?.searchCustomers
      if (!lookup) return
      lookup({ search: query, limit: 8 }).then(found => { if (active) setRows(found) }, () => { if (active) setRows([]) })
    }, 250)
    return () => { active = false; window.clearTimeout(timer) }
  }, [code, search])

  if (!code) return null
  const close = () => { if (!busy) setCode('') }

  async function bind(customer: Found, replace = false) {
    if (busy) return
    setBusy(true)
    try {
      const { data: current } = await customerApi.get(customer.id)
      if (current.card_barcode && current.card_barcode !== code && !replace) { setReplacing({ customer, oldCard: current.card_barcode }); return }
      await customerApi.update(customer.id, { card_barcode: code, expected_updated_at: current.updated_at })
      toast.success(`Картку привʼязано: ${customer.full_name ?? customer.phone ?? 'клієнт'}`)
      const scanned = code
      setCode(''); setReplacing(null)
      // Тепер це картка клієнта: каса обробляє її як звичайне сканування й додає клієнта в чек.
      window.dispatchEvent(new CustomEvent(CAMERA_SCAN_EVENT, { detail: { code: scanned }, cancelable: true }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося привʼязати картку')
    } finally { setBusy(false) }
  }

  return (
    <Modal open onClose={close} title="Нова картка клієнта" size="md">
      <div className="space-y-3" data-free-card={code}>
        <p className="text-sm text-gray-700">Картка <span className="font-mono font-semibold">{code}</span> ще нікому не належить. Кому її видаємо?</p>
        <input ref={inputRef} value={search} onChange={event => setSearch(event.target.value)} placeholder="Телефон або імʼя клієнта" aria-label="Пошук клієнта"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" disabled={busy} />
        {replacing && (
          <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <p>У клієнта {replacing.customer.full_name ?? replacing.customer.phone} вже є картка <span className="font-mono font-semibold">{replacing.oldCard}</span>. Замінити її на нову?</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => void bind(replacing.customer, true)}>Замінити</Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setReplacing(null)}>Скасувати</Button>
            </div>
          </div>
        )}
        {rows !== null && rows.length === 0 && <p className="text-sm text-gray-500">Такого клієнта немає — створіть нового.</p>}
        {rows !== null && rows.length > 0 && (
          <ul className="max-h-56 divide-y divide-gray-100 overflow-y-auto rounded-lg border border-gray-200">
            {rows.map(customer => (
              <li key={customer.id}>
                <button type="button" disabled={busy} onClick={() => void bind(customer)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-yellow-50 disabled:opacity-50">
                  <span className="font-medium text-gray-800">{customer.full_name ?? 'Без імені'}</span>
                  <span className="font-mono text-xs text-gray-500">{customer.phone ?? ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap justify-between gap-2 pt-1">
          <Button variant="secondary" icon={<UserPlus size={14} />} disabled={busy} onClick={() => { const target = newCustomerWithCardPath(code); setCode(''); navigate(target) }}>Новий клієнт із цією карткою</Button>
          <Button variant="secondary" disabled={busy} onClick={close}>Не зараз</Button>
        </div>
      </div>
    </Modal>
  )
}
