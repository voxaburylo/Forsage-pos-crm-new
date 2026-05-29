import { useState, useEffect } from 'react'
import { Plus, Edit2, KeyRound, UserX, UserCheck, Trash2 } from 'lucide-react'
import { adminApi, ROLE_LABELS } from '@/features/admin/adminApi'
import type { AdminUser, UserRole } from '@/features/admin/adminApi'
import { Layout } from '@/components/Layout'
import { Button, Card, Modal, Input, Badge, Table, ConfirmDialog } from '@/components/ui'
type BadgeColor = 'green' | 'orange' | 'red' | 'blue' | 'gray' | 'yellow'
import { toast } from '@/components/ui/Toast'
import { api } from '@/lib/api'

const ROLE_COLORS: Record<UserRole, BadgeColor> = {
  owner:       'yellow',
  admin:       'blue',
  manager:     'green',
  cashier:     'gray',
  storekeeper: 'orange',
  sto_viewer:  'gray',
} as const

export default function StaffPage() {
  const [users, setUsers]          = useState<AdminUser[]>([])
  const [loading, setLoading]      = useState(true)
  const [addOpen, setAddOpen]      = useState(false)
  const [editOpen, setEditOpen]    = useState(false)
  const [passOpen, setPassOpen]    = useState(false)
  const [editUser, setEditUser]    = useState<AdminUser | null>(null)
  const [saving, setSaving]        = useState(false)
  const [deleteConfirmUser, setDeleteConfirmUser] = useState<AdminUser | null>(null)

  // Add form
  const [addForm, setAddForm] = useState({ phone: '', password: '', full_name: '', role: 'cashier' as UserRole })
  // Edit form
  const [editForm, setEditForm] = useState({ role: 'cashier' as UserRole, is_active: true, full_name: '' })
  // Password form
  const [newPass, setNewPass] = useState('')
  const [pinInput, setPinInput] = useState('')

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
      await adminApi.createUser(addForm)
      toast.success('Співробітника додано')
      setAddOpen(false)
      setAddForm({ phone: '', password: '', full_name: '', role: 'cashier' })
      load()
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Помилка') }
    finally { setSaving(false) }
  }

  function openEdit(u: AdminUser) {
    setEditUser(u)
    setEditForm({ role: u.role as UserRole, is_active: u.is_active, full_name: u.full_name })
    setEditOpen(true)
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault()
    if (!editUser) return
    setSaving(true)
    try {
      await adminApi.updateUser(editUser.id, editForm)
      toast.success('Дані оновлено')
      setEditOpen(false)
      load()
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Помилка') }
    finally { setSaving(false) }
  }

  function openPassword(u: AdminUser) {
    setEditUser(u)
    setNewPass('')
    setPassOpen(true)
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault()
    if (!editUser || newPass.length < 6) { toast.error('Мінімум 6 символів'); return }
    setSaving(true)
    try {
      await adminApi.resetPassword(editUser.id, newPass)
      toast.success('Пароль скинуто')
      setPassOpen(false)
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Помилка') }
    finally { setSaving(false) }
  }

  async function toggleActive(u: AdminUser) {
    try {
      await adminApi.updateUser(u.id, { is_active: !u.is_active })
      toast.success(u.is_active ? 'Деактивовано' : 'Активовано')
      load()
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Помилка') }
  }

  async function handleDeleteUser() {
    if (!deleteConfirmUser) return
    setSaving(true)
    try {
      await adminApi.deleteUser(deleteConfirmUser.id)
      toast.success('Співробітника видалено')
      setDeleteConfirmUser(null)
      load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка при видаленні')
    } finally {
      setSaving(false)
    }
  }

  const columns = [
    { key: 'name', header: 'Співробітник', render: (u: AdminUser) => (
      <div>
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-900">{u.full_name || '—'}</span>
        </div>
        <div className="flex gap-2 text-xs text-gray-400 mt-0.5">
          <span className="font-mono">{u.phone}</span>
          <span>·</span>
          <span>{u.email}</span>
        </div>
      </div>
    )},
    { key: 'role', header: 'Роль', render: (u: AdminUser) => (
      <Badge color={ROLE_COLORS[u.role as UserRole] ?? 'gray'}>
        {ROLE_LABELS[u.role as UserRole] ?? u.role}
      </Badge>
    )},
    { key: 'status', header: 'Статус', render: (u: AdminUser) => (
      <Badge color={u.is_active ? 'green' : 'red'}>
        {u.is_active ? 'Активний' : 'Заблокований'}
      </Badge>
    )},
    { key: 'actions', header: '', className: 'w-40 text-right', render: (u: AdminUser) => (
      <div className="flex items-center justify-end gap-1">
        <button onClick={() => openEdit(u)}
          className="p-1.5 text-gray-400 hover:text-yellow-600 rounded-lg hover:bg-yellow-50 transition-colors"
          title="Редагувати">
          <Edit2 size={14} />
        </button>
        <button onClick={() => openPassword(u)}
          className="p-1.5 text-gray-400 hover:text-blue-600 rounded-lg hover:bg-blue-50 transition-colors"
          title="Скинути пароль">
          <KeyRound size={14} />
        </button>
        <button onClick={() => toggleActive(u)}
          className={`p-1.5 rounded-lg transition-colors ${
            u.is_active
              ? 'text-gray-400 hover:text-red-600 hover:bg-red-50'
              : 'text-green-500 hover:text-green-700 hover:bg-green-50'
          }`}
          title={u.is_active ? 'Деактивувати' : 'Активувати'}>
          {u.is_active ? <UserX size={14} /> : <UserCheck size={14} />}
        </button>
        <button onClick={() => setDeleteConfirmUser(u)}
          className="p-1.5 text-gray-400 hover:text-red-600 rounded-lg hover:bg-red-50 transition-colors"
          title="Видалити повністю">
          <Trash2 size={14} />
        </button>
      </div>
    )},
  ]

  return (
    <Layout title="Команда">
      <div className="max-w-4xl">
        <div className="flex justify-between items-center mb-4">
          <p className="text-sm text-gray-500">Управління співробітниками: {users.length} осіб</p>
          <Button icon={<Plus size={16} />} onClick={() => setAddOpen(true)}>
            Додати співробітника
          </Button>
        </div>

        <Card padding="none">
          <Table
            columns={columns}
            data={users}
            keyFn={(u) => u.id}
            loading={loading}
            empty={<p className="text-gray-400 text-sm py-12 text-center">Співробітників не знайдено</p>}
          />
        </Card>
      </div>

      {/* Модалка: додати */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Додати співробітника" size="sm">
        <form onSubmit={handleCreate} className="space-y-4">
          <Input label="Телефон *" type="tel" value={addForm.phone}
            onChange={(e) => setAddForm((f) => ({ ...f, phone: e.target.value }))}
            placeholder="+380671234567" required />
          <Input label="Повне ім'я *" value={addForm.full_name}
            onChange={(e) => setAddForm((f) => ({ ...f, full_name: e.target.value }))}
            placeholder="Іванов Іван Іванович" required />
          <Input label="Пароль *" type="password" value={addForm.password}
            onChange={(e) => setAddForm((f) => ({ ...f, password: e.target.value }))}
            placeholder="Мінімум 6 символів" required />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Роль *</label>
            <select value={addForm.role}
              onChange={(e) => setAddForm((f) => ({ ...f, role: e.target.value as UserRole }))}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
              {Object.entries(ROLE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="flex gap-3 pt-2">
            <Button type="submit" loading={saving} className="flex-1">Створити</Button>
            <Button type="button" variant="secondary" onClick={() => setAddOpen(false)}>Скасувати</Button>
          </div>
        </form>
      </Modal>

      {/* Модалка: редагувати */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title="Редагувати співробітника" size="sm">
        <form onSubmit={handleEdit} className="space-y-4">
          <div className="text-sm text-gray-600 mb-2">
            {editUser?.full_name} — {editUser?.phone}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Роль</label>
            <select value={editForm.role}
              onChange={(e) => setEditForm((f) => ({ ...f, role: e.target.value as UserRole }))}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent">
              {Object.entries(ROLE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <input type="checkbox" id="edit_active"
              checked={editForm.is_active}
              onChange={(e) => setEditForm((f) => ({ ...f, is_active: e.target.checked }))}
              className="w-4 h-4 accent-yellow-400" />
            <label htmlFor="edit_active" className="text-sm text-gray-700">Активний</label>
          </div>
          <div className="flex gap-3 pt-2">
            <Button type="submit" loading={saving} className="flex-1">Зберегти</Button>
            <Button type="button" variant="secondary" onClick={() => setEditOpen(false)}>Скасувати</Button>
          </div>
        </form>
      </Modal>

      {/* Модалка: скинути пароль */}
      <Modal open={passOpen} onClose={() => setPassOpen(false)} title="Скинути пароль / PIN" size="sm">
        <form onSubmit={handleResetPassword} className="space-y-4">
          <p className="text-sm text-gray-600">
            <strong>{editUser?.full_name}</strong> ({editUser?.phone})
          </p>
          <Input label="Новий пароль" type="password" value={newPass}
            onChange={(e) => setNewPass(e.target.value)}
            placeholder="Мінімум 6 символів" />
          <div className="flex gap-3 pt-2">
            <Button type="submit" loading={saving} className="flex-1">Зберегти пароль</Button>
            <Button type="button" variant="secondary" onClick={() => setPassOpen(false)}>Скасувати</Button>
          </div>
          <div className="border-t border-gray-100 pt-3">
            <label className="block text-sm font-medium text-gray-700 mb-2">PIN-код для входу в касу</label>
            <div className="flex gap-2">
              <input type="text" maxLength={4} pattern="[0-9]*" inputMode="numeric"
                value={pinInput} onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="0000"
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono text-center text-lg tracking-widest focus:outline-none focus:ring-2 focus:ring-accent" />
              <Button size="sm" onClick={async () => {
                  if (pinInput.length !== 4) { toast.error('PIN має містити 4 цифри'); return }
                  if (!editUser) return
                  try {
                    await api.post('/api/v1/auth/set-pin', { user_id: editUser.id, pin: pinInput })
                    toast.success('PIN-код збережено')
                    setPinInput('')
                  } catch (e) { toast.error(e instanceof Error ? e.message : 'Помилка') }
                }}>Зберегти PIN</Button>
            </div>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={deleteConfirmUser !== null}
        onClose={() => setDeleteConfirmUser(null)}
        onConfirm={handleDeleteUser}
        title="Видалити співробітника"
        message={
          <>
            Ви впевнені, що хочете повністю видалити співробітника <strong>{deleteConfirmUser?.full_name}</strong> ({deleteConfirmUser?.phone})?
            <br />
            <span className="text-red-500 text-xs mt-2 block">
              Ця дія є незворотною. Зв'язані документи та історія операцій залишаться в базі даних, але зв'язок із цим користувачем буде розірвано.
            </span>
          </>
        }
        confirmLabel="Видалити"
        danger
      />
    </Layout>
  )
}
