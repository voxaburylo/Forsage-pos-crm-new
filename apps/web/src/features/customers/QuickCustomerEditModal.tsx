import { useEffect, useState } from 'react'
import { Button, Input, Modal } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import type { Customer } from '@/types/customer'
import { customerApi } from './customerApi'

interface Props {
  customer: Customer | null
  open: boolean
  onClose: () => void
  onSaved: (customer: Customer) => void
}

export function QuickCustomerEditModal({ customer, open, onClose, onSaved }: Props) {
  const [phone, setPhone] = useState('')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [cardBarcode, setCardBarcode] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!customer || !open) return
    setPhone(customer.phone ?? '')
    setFullName(customer.full_name ?? '')
    setEmail(customer.email ?? '')
    setCardBarcode(customer.card_barcode ?? '')
  }, [customer, open])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!customer) return
    if (!phone.trim()) {
      toast.error("Телефон обов'язковий")
      return
    }

    setSaving(true)
    try {
      const { data } = await customerApi.update(customer.id, {
        phone: phone.trim(),
        full_name: fullName.trim(),
        email: email.trim(),
        card_barcode: cardBarcode.trim() || null,
      })
      onSaved(data)
      toast.success('Контакти клієнта оновлено')
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не вдалося оновити контакти')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Швидке редагування клієнта" size="sm">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-gray-500">
          Тут зібрані найчастіші зміни. Автомобілі, знижки й примітки залишаються у повній картці.
        </p>
        <Input
          label="Телефон *"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          autoFocus
          required
        />
        <Input
          label="Ім'я"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
        />
        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          label="Штрихкод картки"
          value={cardBarcode}
          onChange={(e) => setCardBarcode(e.target.value.replace(/\s/g, ''))}
          placeholder="Скануйте картку або введіть номер"
        />
        <div className="flex gap-2 pt-1">
          <Button type="submit" loading={saving} className="flex-1">
            Зберегти
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Скасувати
          </Button>
        </div>
      </form>
    </Modal>
  )
}
