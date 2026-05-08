import { useState, useEffect } from 'react'
import { Users, Package, Tag, Plus, Edit2, Trash2, UserX, UserCheck } from 'lucide-react'
import { adminApi, ROLE_LABELS } from './adminApi'
import type { AdminUser, UserRole } from './adminApi'
import { Layout } from '@/components/Layout'
import { Button, Card, Modal, Input, Badge, Table } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

type Tab = 'users' | 'categories' | 'brands'

// ---- Users Tab ----
function UsersTab() {
  const [users, setUsers]         = useState<AdminUser[]>([])
  const [loading, setLoading]     = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState({ phone: '', password: '', full_name: '', role: 'cashier' as UserRole })
  const [saving, setSaving]       = useState(false)

  async function load() {
    setLoading(true)
    try { const { data } = await adminApi.listUsers(); setUsers(data) }
    catch { toast.error('Помилка завантаження') }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      await adminApi.createUser(form)
      toast.success('Користувача створено')
      setModalOpen(false)
      setForm({ phone: '', password: '', full_name: '', role: 'cashier' })
      load()
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Помилка') }
    finally { setSaving(false) }
  }

  async function toggleActive(u: AdminUser) {
    try {
      await adminApi.updateUser(u.id, { is_active: !u.is_active })
      toast.success(u.is_active ? 'Користувача деактивовано' : 'Користувача активовано')
      load()
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Помилка') }
  }

  async function handleRoleChange(u: AdminUser, role: UserRole) {
    try {
      await adminApi.updateUser(u.id, { role })
      toast.success('Роль змінено')
      load()
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Помилка') }
  }

  const columns = [
    { key: 'name', header: "Ім'я/Телефон", render: (u: AdminUser) => (
      <div>
        <p className="font-medium text-gray-900">{u.full_name || '—'}</p>
        <p className="text-xs text-gray-400 font-mono">{u.phone}</p>
      </div>
    )},
    { key: 'role', header: 'Роль', render: (u: AdminUser) => (
      <select value={u.role} onChange={(e) => handleRoleChange(u, e.target.value as UserRole)}
        className="border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-accent">
        {Object.entries(ROLE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    )},
    { key: 'status', header: 'Статус', className: 'w-24', render: (u: AdminUser) => (
      <Badge color={u.is_active ? 'green' : 'red'}>{u.is_active ? 'Активний' : 'Заблокований'}</Badge>
    )},
    { key: 'actions', header: '', className: 'w-16 text-right', render: (u: AdminUser) => (
      <button onClick={() => toggleActive(u)} title={u.is_active ? 'Деактивувати' : 'Активувати'}
        className={`text-sm ${u.is_active ? 'text-red-400 hover:text-red-600' : 'text-green-500 hover:text-green-700'}`}>
        {u.is_active ? <UserX size={16} /> : <UserCheck size={16} />}
      </button>
    )},
  ]

  return (
    <>
      <div className="flex justify-end mb-4">
        <Button icon={<Plus size={16} />} onClick={() => setModalOpen(true)}>Новий користувач</Button>
      </div>
      <Card padding="none">
        <Table columns={columns} data={users} keyFn={(u) => u.id} loading={loading}
          empty={<p className="text-gray-400 text-sm">Користувачів не знайдено</p>} />
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Новий користувач" size="sm">
        <form onSubmit={handleCreate} className="space-y-4">
          <Input label="Телефон *" type="tel" value={form.phone}
            onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            placeholder="+380671234567" required />
          <Input label="Повне ім'я *" value={form.full_name}
            onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))}
            placeholder="Іванов Іван Іванович" required />
          <Input label="Пароль *" type="password" value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            placeholder="мінімум 6 символів" required />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Роль *</label>
            <select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as UserRole }))}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
              {Object.entries(ROLE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="flex gap-3">
            <Button type="submit" loading={saving} className="flex-1">Створити</Button>
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>Скасувати</Button>
          </div>
        </form>
      </Modal>
    </>
  )
}

// ---- Simple CRUD Tab (categories/brands) ----
function SimpleListTab({ type }: { type: 'categories' | 'brands' }) {
  type Item = { id: string; name: string; country?: string | null; sort_order?: number }
  const [items, setItems]         = useState<Item[]>([])
  const [loading, setLoading]     = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [name, setName]           = useState('')
  const [extra, setExtra]         = useState('')
  const [saving, setSaving]       = useState(false)

  async function load() {
    setLoading(true)
    try {
      const res = type === 'categories' ? await adminApi.listCategories() : await adminApi.listBrands()
      setItems(res.data as Item[])
    } catch { toast.error('Помилка завантаження') }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [type])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    try {
      if (type === 'categories') await adminApi.createCategory(name)
      else await adminApi.createBrand(name, extra || undefined)
      toast.success(type === 'categories' ? 'Категорію створено' : 'Бренд створено')
      setModalOpen(false); setName(''); setExtra('')
      load()
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Помилка') }
    finally { setSaving(false) }
  }

  async function handleDelete(id: string) {
    if (!confirm('Видалити?')) return
    try {
      if (type === 'categories') await adminApi.deleteCategory(id)
      toast.success('Видалено')
      load()
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Помилка') }
  }

  const columns = [
    { key: 'name', header: 'Назва', render: (i: Item) => <span className="font-medium">{i.name}</span> },
    ...(type === 'brands' ? [{ key: 'country', header: 'Країна', render: (i: Item) => <span className="text-gray-500">{i.country ?? '—'}</span> }] : []),
    { key: 'del', header: '', className: 'w-12 text-right', render: (i: Item) => (
      type === 'categories'
        ? <button onClick={() => handleDelete(i.id)} className="text-red-400 hover:text-red-600"><Trash2 size={14} /></button>
        : <button className="text-gray-300 cursor-not-allowed" title="Бренди не видаляються"><Edit2 size={14} /></button>
    )},
  ]

  const title = type === 'categories' ? 'Нова категорія' : 'Новий бренд'

  return (
    <>
      <div className="flex justify-end mb-4">
        <Button icon={<Plus size={16} />} onClick={() => setModalOpen(true)}>{title}</Button>
      </div>
      <Card padding="none">
        <Table columns={columns} data={items} keyFn={(i) => i.id} loading={loading}
          empty={<p className="text-gray-400 text-sm">Нічого не знайдено</p>} />
      </Card>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={title} size="sm">
        <form onSubmit={handleCreate} className="space-y-4">
          <Input label="Назва *" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          {type === 'brands' && (
            <Input label="Країна" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Germany, Japan..." />
          )}
          <div className="flex gap-3">
            <Button type="submit" loading={saving} className="flex-1">Створити</Button>
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>Скасувати</Button>
          </div>
        </form>
      </Modal>
    </>
  )
}

// ---- Main AdminPage ----
export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('users')

  const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'users',      label: 'Користувачі',  icon: <Users size={16} /> },
    { id: 'categories', label: 'Категорії',    icon: <Tag size={16} /> },
    { id: 'brands',     label: 'Бренди',       icon: <Package size={16} /> },
  ]

  return (
    <Layout title="Адміністрування">
      <div className="flex gap-2 mb-6">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t.id ? 'bg-accent text-black' : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
            }`}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {tab === 'users'      && <UsersTab />}
      {tab === 'categories' && <SimpleListTab type="categories" />}
      {tab === 'brands'     && <SimpleListTab type="brands" />}
    </Layout>
  )
}
