import { useState } from 'react'
import { customerApi } from './customerApi'
import type { Customer } from '@/types/customer'
import { Modal, Button, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

interface Props {
  open: boolean
  onClose: () => void
  onCreated: (customer: Customer) => void
}

export function QuickCustomerModal({ open, onClose, onCreated }: Props) {
  const [phone, setPhone]       = useState('')
  const [name, setName]         = useState('')
  const [saving, setSaving]     = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!phone.trim()) { toast.error('Телефон обов\'язковий'); return }
    if (!name.trim())  { toast.error('Ім\'я обов\'язкове'); return }

    setSaving(true)
    try {
      const { data } = await customerApi.quickCreate(phone, name)
      toast.success('Клієнта створено')
      onCreated(data)
      setPhone('')
      setName('')
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Новий клієнт" size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Телефон *"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+380671234567"
          autoFocus
          required
        />
        <Input
          label="Ім'я *"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Іван Іваненко"
          required
        />
        <div className="flex gap-3">
          <Button type="submit" loading={saving} className="flex-1">
            Створити
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Скасувати
          </Button>
        </div>
      </form>
    </Modal>
  )
}
