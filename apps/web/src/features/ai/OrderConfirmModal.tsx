import { useMemo, useState } from 'react'
import { AlertTriangle, Check, Plus, Trash2 } from 'lucide-react'
import { Button, Modal } from '@/components/ui'
import type { AiPendingAction } from './aiApi'

// Редаговане підтвердження замовлення, розпізнаного ШІ з фото зошита.
// Сумнівні поля (uncertain) підсвічуються бурштиновим — їх варто перевірити.

interface OrderItemDraft {
  name: string
  part_number: string
  qty: string
  sell_price_uah: string
  buy_price_uah: string
  arrived: boolean
}

interface OrderDraft {
  customer_name: string
  customer_phone: string
  car_make: string
  car_model: string
  car_year: string
  vin: string
  plate: string
  comment: string
  is_done: boolean
  items: OrderItemDraft[]
}

const UNCERTAIN_LABELS: Record<string, string> = {
  customer_name: 'імʼя клієнта',
  customer_phone: 'телефон',
  car: 'авто',
  vin: 'VIN',
  plate: 'держномер',
  items: 'позиції',
  prices: 'ціни',
  status: 'статус',
}

function toDraft(payload: Record<string, any>): OrderDraft {
  const items: any[] = Array.isArray(payload.items) ? payload.items : []
  return {
    customer_name: String(payload.customer_name ?? ''),
    customer_phone: String(payload.customer_phone ?? ''),
    car_make: String(payload.car_make ?? ''),
    car_model: String(payload.car_model ?? ''),
    car_year: payload.car_year != null ? String(payload.car_year) : '',
    vin: String(payload.vin ?? ''),
    plate: String(payload.plate ?? ''),
    comment: String(payload.comment ?? ''),
    is_done: !!payload.is_done,
    items: items.map((it) => ({
      name: String(it.name ?? ''),
      part_number: String(it.part_number ?? ''),
      qty: it.qty != null ? String(it.qty) : '1',
      sell_price_uah: it.sell_price_uah != null ? String(it.sell_price_uah) : '',
      buy_price_uah: it.buy_price_uah != null ? String(it.buy_price_uah) : '',
      arrived: !!it.arrived,
    })),
  }
}

function toPayload(d: OrderDraft): Record<string, any> {
  const num = (s: string): number | undefined => {
    const n = Number(String(s).replace(',', '.'))
    return Number.isFinite(n) && s.trim() !== '' ? n : undefined
  }
  return {
    customer_name: d.customer_name.trim() || undefined,
    customer_phone: d.customer_phone.trim() || undefined,
    car_make: d.car_make.trim() || undefined,
    car_model: d.car_model.trim() || undefined,
    car_year: num(d.car_year) ? Math.round(num(d.car_year)!) : undefined,
    vin: d.vin.trim() || undefined,
    plate: d.plate.trim() || undefined,
    comment: d.comment.trim() || undefined,
    is_done: d.is_done,
    items: d.items
      .filter((it) => it.name.trim())
      .map((it) => ({
        name: it.name.trim(),
        part_number: it.part_number.trim() || undefined,
        qty: num(it.qty) ?? 1,
        sell_price_uah: num(it.sell_price_uah),
        buy_price_uah: num(it.buy_price_uah),
        arrived: it.arrived,
      })),
  }
}

interface Props {
  action: AiPendingAction
  applying: boolean
  onConfirm: (editedPayload: Record<string, any>) => void
  onClose: () => void
}

export function OrderConfirmModal({ action, applying, onConfirm, onClose }: Props) {
  const [draft, setDraft] = useState<OrderDraft>(() => toDraft(action.payload))
  const uncertain = useMemo(() => new Set(action.uncertain ?? []), [action.uncertain])

  const warn = (key: string) =>
    uncertain.has(key) ? 'ring-2 ring-amber-300 border-amber-300 bg-amber-50/60' : ''

  const set = <K extends keyof OrderDraft>(key: K, value: OrderDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const setItem = (idx: number, patch: Partial<OrderItemDraft>) =>
    setDraft((d) => ({
      ...d,
      items: d.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)),
    }))

  const removeItem = (idx: number) =>
    setDraft((d) => ({ ...d, items: d.items.filter((_, i) => i !== idx) }))

  const addItem = () =>
    setDraft((d) => ({
      ...d,
      items: [...d.items, { name: '', part_number: '', qty: '1', sell_price_uah: '', buy_price_uah: '', arrived: false }],
    }))

  const totalUah = draft.items.reduce((s, it) => {
    const price = Number(String(it.sell_price_uah).replace(',', '.')) || 0
    const qty = Number(String(it.qty).replace(',', '.')) || 0
    return s + price * qty
  }, 0)

  const canSave = draft.items.some((it) => it.name.trim())

  const inputCls = 'w-full border border-gray-200 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent'
  const cellCls = 'w-full border border-gray-200 rounded-md px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent'

  return (
    <Modal open onClose={onClose} title={action.title} size="xl">
      <div className="space-y-4">
        {uncertain.size > 0 && (
          <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              ШІ не впевнений у розпізнаванні: <b>{[...uncertain].map((u) => UNCERTAIN_LABELS[u] ?? u).join(', ')}</b>.
              Перевірте підсвічені поля перед збереженням.
            </span>
          </div>
        )}

        {/* Клієнт */}
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase mb-1.5">Клієнт</p>
          <div className="grid grid-cols-2 gap-2">
            <input
              value={draft.customer_name}
              onChange={(e) => set('customer_name', e.target.value)}
              placeholder="Імʼя клієнта"
              aria-label="Імʼя клієнта"
              className={`${inputCls} ${warn('customer_name')}`}
            />
            <input
              value={draft.customer_phone}
              onChange={(e) => set('customer_phone', e.target.value)}
              placeholder="+380…"
              aria-label="Телефон клієнта"
              className={`${inputCls} ${warn('customer_phone')}`}
            />
          </div>
          <p className="text-[11px] text-gray-400 mt-1">
            Якщо клієнт з таким телефоном уже є в базі — замовлення привʼяжеться до нього, дубль не створиться.
          </p>
        </div>

        {/* Авто */}
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase mb-1.5">Авто</p>
          <div className="grid grid-cols-3 gap-2">
            <input value={draft.car_make} onChange={(e) => set('car_make', e.target.value)}
              placeholder="Марка" aria-label="Марка авто" className={`${inputCls} ${warn('car')}`} />
            <input value={draft.car_model} onChange={(e) => set('car_model', e.target.value)}
              placeholder="Модель" aria-label="Модель авто" className={`${inputCls} ${warn('car')}`} />
            <input value={draft.car_year} onChange={(e) => set('car_year', e.target.value)}
              placeholder="Рік" aria-label="Рік випуску" inputMode="numeric" className={`${inputCls} ${warn('car')}`} />
          </div>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <input value={draft.vin} onChange={(e) => set('vin', e.target.value)}
              placeholder="VIN (17 символів)" aria-label="VIN" className={`${inputCls} font-mono ${warn('vin')}`} />
            <input value={draft.plate} onChange={(e) => set('plate', e.target.value)}
              placeholder="Держномер (АА1234АА)" aria-label="Держномер" className={`${inputCls} font-mono ${warn('plate')}`} />
          </div>
        </div>

        {/* Позиції */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className={`text-xs font-semibold uppercase ${uncertain.has('items') || uncertain.has('prices') ? 'text-amber-600' : 'text-gray-400'}`}>
              Запчастини {uncertain.has('items') || uncertain.has('prices') ? '— перевірте!' : ''}
            </p>
            <button type="button" onClick={addItem}
              className="text-xs text-gray-500 hover:text-gray-800 flex items-center gap-1">
              <Plus size={13} /> Додати позицію
            </button>
          </div>
          <div className={`rounded-lg border overflow-hidden ${uncertain.has('items') || uncertain.has('prices') ? 'border-amber-300' : 'border-gray-200'}`}>
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-400">
                <tr>
                  <th className="px-2 py-1.5 text-left font-semibold">Назва</th>
                  <th className="px-2 py-1.5 text-left font-semibold w-28">Кат. номер</th>
                  <th className="px-2 py-1.5 text-left font-semibold w-14">К-сть</th>
                  <th className="px-2 py-1.5 text-left font-semibold w-20">Ціна, грн</th>
                  <th className="px-2 py-1.5 text-left font-semibold w-20">Закуп, грн</th>
                  <th className="px-1 py-1.5 text-center font-semibold w-16" title="Запчастина вже прибула">Прибула</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {draft.items.map((it, i) => (
                  <tr key={i} className="align-top">
                    <td className="px-1.5 py-1">
                      <input value={it.name} onChange={(e) => setItem(i, { name: e.target.value })}
                        placeholder="Назва запчастини" aria-label={`Назва позиції ${i + 1}`} className={cellCls} />
                    </td>
                    <td className="px-1.5 py-1">
                      <input value={it.part_number} onChange={(e) => setItem(i, { part_number: e.target.value })}
                        placeholder="—" aria-label={`Каталожний номер позиції ${i + 1}`} className={`${cellCls} font-mono`} />
                    </td>
                    <td className="px-1.5 py-1">
                      <input value={it.qty} onChange={(e) => setItem(i, { qty: e.target.value })}
                        inputMode="decimal" aria-label={`Кількість позиції ${i + 1}`} className={cellCls} />
                    </td>
                    <td className="px-1.5 py-1">
                      <input value={it.sell_price_uah} onChange={(e) => setItem(i, { sell_price_uah: e.target.value })}
                        placeholder="—" inputMode="decimal" aria-label={`Ціна продажу позиції ${i + 1}`} className={cellCls} />
                    </td>
                    <td className="px-1.5 py-1">
                      <input value={it.buy_price_uah} onChange={(e) => setItem(i, { buy_price_uah: e.target.value })}
                        placeholder="порожньо" inputMode="decimal" aria-label={`Закупівельна ціна позиції ${i + 1}`} className={cellCls} />
                    </td>
                    <td className="px-1 py-1 text-center">
                      <input type="checkbox" checked={it.arrived}
                        onChange={(e) => setItem(i, { arrived: e.target.checked })}
                        aria-label={`Позиція ${i + 1} прибула`}
                        className="mt-2 w-4 h-4 accent-green-600" />
                    </td>
                    <td className="px-1 py-1 text-center">
                      <button type="button" onClick={() => removeItem(i)} title="Видалити позицію"
                        aria-label={`Видалити позицію ${i + 1}`}
                        className="mt-1.5 text-gray-300 hover:text-red-500">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Коментар + статус */}
        <div className="grid grid-cols-1 gap-2">
          <textarea
            value={draft.comment}
            onChange={(e) => set('comment', e.target.value)}
            placeholder="Коментар до замовлення"
            aria-label="Коментар до замовлення"
            rows={2}
            className={`${inputCls} resize-none`}
          />
          <label className={`flex items-center gap-2 text-sm rounded-lg border px-3 py-2.5 cursor-pointer select-none ${
            draft.is_done ? 'border-green-300 bg-green-50 text-green-800' : 'border-gray-200 text-gray-600'
          } ${warn('status')}`}>
            <input type="checkbox" checked={draft.is_done}
              onChange={(e) => set('is_done', e.target.checked)}
              className="w-4 h-4 accent-green-600" />
            Замовлення виконане (перекреслене в зошиті) — створити одразу в архіві як оплачене
          </label>
        </div>

        {/* Підсумок + кнопки */}
        <div className="flex items-center justify-between pt-3 border-t border-gray-100">
          <p className="text-sm text-gray-500">
            Разом: <b className="text-gray-900">{totalUah.toFixed(2)} грн</b>
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Скасувати</Button>
            <Button type="button" loading={applying} disabled={!canSave}
              onClick={() => onConfirm(toPayload(draft))}>
              <Check size={16} className="mr-1" /> Створити замовлення
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
