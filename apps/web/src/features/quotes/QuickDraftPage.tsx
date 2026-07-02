import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ClipboardList, Save } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button, Card, Input } from '@/components/ui'
import { customerApi } from '@/features/customers/customerApi'
import { orderApi } from '@/features/orders/orderApi'
import { api } from '@/lib/api'
import { toast } from '@/components/ui/Toast'

function digits(value: string) {
  return value.replace(/\D/g, '')
}

export default function QuickDraftPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const [phone, setPhone] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [vin, setVin] = useState(() => searchParams.get('vin')?.trim().toUpperCase() ?? '')
  const [partsText, setPartsText] = useState('')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(!!id)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!id) return
    orderApi.get(id)
      .then(({ data }) => {
        setPhone(data.customer?.phone ?? '')
        setCustomerName(data.customer?.full_name ?? '')
        setVin(data.vehicle_info?.vin ?? '')
        setPartsText(data.items.map((item) => item.name).join('\n'))
        setNote(data.comment ?? '')
      })
      .catch(() => {
        toast.error('Чернетку не знайдено')
        navigate('/orders?tab=drafts')
      })
      .finally(() => setLoading(false))
  }, [id, navigate])

  const parts = useMemo(
    () => partsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    [partsText],
  )

  async function resolveCustomerId() {
    const cleanPhone = phone.trim()
    if (!cleanPhone) return null
    const result = await customerApi.list({ search: cleanPhone, per_page: 10 })
    const exact = result.data.find((customer) => digits(customer.phone) === digits(cleanPhone))
    if (exact) return exact.id
    const created = await customerApi.quickCreate(cleanPhone, customerName.trim() || 'Без імені')
    return created.data.id
  }

  async function save() {
    if (!phone.trim()) {
      toast.error('Вкажіть телефон клієнта')
      return
    }
    if (!vin.trim()) {
      toast.error('Вкажіть VIN-код')
      return
    }
    if (parts.length === 0) {
      toast.error('Напишіть хоча б одну запчастину')
      return
    }

    setSaving(true)
    try {
      const customerId = await resolveCustomerId()
      const payload = {
        customer_id: customerId,
        vehicle_info: { vin: vin.trim().toUpperCase() },
        comment: note.trim() || null,
        items: parts.map((name) => ({
          name,
          qty: 1,
          sell_price: 0,
          buy_price: 0,
          source_type: 'supplier' as const,
          is_draft_note: true,
          variants: [],
        })),
      }

      if (id) {
        await api.put(`/api/v1/customer-orders/${id}/draft`, payload)
        toast.success('Чернетку оновлено')
      } else {
        await orderApi.create({
          ...payload,
          source: 'mobile_draft',
          prepayment: 0,
        })
        toast.success('Чернетку збережено')
      }
      navigate('/orders?tab=drafts')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося зберегти чернетку')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <Layout title="Швидка чернетка"><p className="py-12 text-center text-sm text-gray-400">Завантаження...</p></Layout>
  }

  return (
    <Layout title={id ? 'Редагувати чернетку' : 'Швидка чернетка'} onBack={() => navigate('/orders?tab=drafts')}>
      <div className="mx-auto max-w-2xl space-y-4">
        <Card className="border-yellow-200 bg-yellow-50">
          <div className="flex gap-3">
            <ClipboardList className="mt-0.5 shrink-0 text-yellow-700" size={21} />
            <div>
              <h2 className="font-bold text-gray-900">Запишіть тільки те, що сказав клієнт</h2>
              <p className="mt-1 text-sm text-gray-600">
                Без артикулів, цін і пошуку. Кожну потрібну запчастину пишіть з нового рядка.
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Телефон клієнта *" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+380…" autoFocus />
            <Input label="Ім’я (необов’язково)" value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Як звертатися" />
          </div>
          <div className="mt-4">
            <Input
              label="VIN-код *"
              value={vin}
              onChange={(e) => setVin(e.target.value.toUpperCase())}
              placeholder="17 символів"
              className="font-mono font-bold uppercase tracking-wider"
            />
          </div>
          <div className="mt-4">
            <label className="mb-1 block text-sm font-medium text-gray-700">Список запчастин *</label>
            <textarea
              value={partsText}
              onChange={(e) => setPartsText(e.target.value)}
              rows={9}
              placeholder={'Шарова\nНаконечник\nРучка двері'}
              className="w-full resize-y rounded-xl border border-gray-200 px-3 py-3 text-base leading-7 outline-none focus:border-yellow-400 focus:ring-2 focus:ring-yellow-100"
            />
            <p className="mt-1 text-xs text-gray-400">Зараз записано позицій: {parts.length}</p>
          </div>
          <div className="mt-4">
            <label className="mb-1 block text-sm font-medium text-gray-700">Загальна нотатка</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Передзвонити після підбору, терміново тощо"
              className="w-full resize-none rounded-xl border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-yellow-400 focus:ring-2 focus:ring-yellow-100"
            />
          </div>
        </Card>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => navigate('/orders?tab=drafts')}>Скасувати</Button>
          <Button icon={<Save size={16} />} loading={saving} onClick={save}>Зберегти чернетку</Button>
        </div>
      </div>
    </Layout>
  )
}
