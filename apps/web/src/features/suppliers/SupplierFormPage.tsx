import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supplierApi } from './supplierApi'
import type { SupplierFormData } from '@/types/supplier'
import { Layout } from '@/components/Layout'
import { Button, Input, Card } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

const EMPTY: SupplierFormData = { name: '', phone: '', email: '', contact_name: '', notes: '' }

export default function SupplierFormPage() {
  const navigate = useNavigate()
  const { id } = useParams()
  const isEdit = Boolean(id)
  const [form, setForm] = useState<SupplierFormData>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(isEdit)

  useEffect(() => {
    if (id) {
      supplierApi.get(id).then((res) => {
        const s = res.data
        setForm({
          name: s.name,
          phone: s.phone ?? '',
          email: s.email ?? '',
          contact_name: s.contact_name ?? '',
          notes: s.notes ?? '',
        })
      }).catch(() => {
        toast.error('Не вдалось завантажити постачальника')
        navigate('/suppliers')
      }).finally(() => setLoading(false))
    }
  }, [id])

  function set<K extends keyof SupplierFormData>(k: K, v: SupplierFormData[K]) {
    setForm((prev) => ({ ...prev, [k]: v }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) { toast.error('Назва обов\'язкова'); return }

    setSaving(true)
    try {
      const body = {
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        contact_name: form.contact_name.trim() || null,
        notes: form.notes.trim() || null,
      }
      if (isEdit) {
        await supplierApi.update(id!, body)
        toast.success('Постачальника оновлено')
      } else {
        await supplierApi.create(body)
        toast.success('Постачальника створено')
      }
      navigate('/suppliers')
    } catch {
      toast.error('Помилка збереження')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Layout title="Завантаження..."><div className="text-gray-400 text-sm">Завантаження...</div></Layout>

  return (
    <Layout
      title={isEdit ? 'Редагувати постачальника' : 'Новий постачальник'}
      onBack={() => navigate('/suppliers')}
    >
      <form onSubmit={handleSubmit} className="max-w-xl">
        <Card className="space-y-4">
          <Input label="Назва *" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Назва компанії" required />
          <Input label="Телефон" value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+380501234567" />
          <Input label="Email" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="email@example.com" />
          <Input label="Контактна особа" value={form.contact_name} onChange={(e) => set('contact_name', e.target.value)} placeholder="ПІБ" />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Нотатки</label>
            <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
              rows={3} placeholder="Додаткова інформація..." />
          </div>
          <div className="flex gap-3 pt-2">
            <Button type="submit" disabled={saving}>
              {saving ? 'Збереження...' : isEdit ? 'Зберегти' : 'Створити'}
            </Button>
            <Button type="button" variant="outline" onClick={() => navigate('/suppliers')}>
              Скасувати
            </Button>
          </div>
        </Card>
      </form>
    </Layout>
  )
}