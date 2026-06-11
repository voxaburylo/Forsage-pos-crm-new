import { useState, useEffect, useCallback } from 'react'
import {
  Plus, Trash2, X, Percent,
  DollarSign, Award, AlertTriangle, ArrowDownRight
} from 'lucide-react'
import { adminApi, ROLE_LABELS } from '@/features/admin/adminApi'
import type { AdminUser, UserRole } from '@/features/admin/adminApi'
import { commissionApi } from '@/features/settings/commissionApi'
import type { CommissionRule } from '@/features/settings/commissionApi'
import { Layout } from '@/components/Layout'
import { Button, Card, Modal, Input, Badge, Table, ConfirmDialog } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { api } from '@/lib/api'
import { formatMoney } from '@/lib/utils'

type BadgeColor = 'green' | 'orange' | 'red' | 'blue' | 'gray' | 'yellow'

const ROLE_COLORS: Record<UserRole, BadgeColor> = {
  owner:       'yellow',
  admin:       'blue',
  manager:     'green',
  cashier:     'gray',
  storekeeper: 'orange',
  sto_viewer:  'gray',
} as const

interface EmployeeSummary {
  employee_id: string
  employee_name: string
  salary: number
  bonus: number
  advance: number
  penalty: number
  earned: number
  paid: number
  balance: number
  total: number
}

interface SalaryPayment {
  id: string
  employee_id: string
  employee_name: string
  amount: number
  type: 'salary' | 'bonus' | 'advance' | 'penalty'
  method: 'cash' | 'card' | 'transfer'
  period: string
  note: string | null
  created_at: string
}

const TYPE_CONFIG = {
  salary:  { label: 'Ставка',   color: 'bg-green-100 text-green-700',  icon: <DollarSign size={12} /> },
  bonus:   { label: 'Премія',   color: 'bg-yellow-100 text-yellow-700', icon: <Award size={12} /> },
  advance: { label: 'Виплата',  color: 'bg-blue-100 text-blue-700',     icon: <ArrowDownRight size={12} /> },
  penalty: { label: 'Штраф',    color: 'bg-red-100 text-red-700',       icon: <AlertTriangle size={12} /> },
}

const METHOD_LABELS = { cash: 'Готівка', card: 'Картка', transfer: 'Переказ' }

function currentPeriod() {
  return new Date().toISOString().slice(0, 7)
}

function periodLabel(p: string) {
  const [y, m] = p.split('-')
  const months = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень']
  return `${months[parseInt(m) - 1]} ${y}`
}

export default function StaffPage() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [period, setPeriod] = useState(currentPeriod())
  const [summary, setSummary] = useState<EmployeeSummary[]>([])
  const [payments, setPayments] = useState<SalaryPayment[]>([])
  const [rules, setRules] = useState<CommissionRule[]>([])
  const [brands, setBrands] = useState<Array<{ id: string; name: string }>>([])
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([])
  
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [deleteConfirmUser, setDeleteConfirmUser] = useState<AdminUser | null>(null)

  // Drawer (співробітник у фокусі)
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null)
  const [drawerTab, setDrawerTab] = useState<'profile' | 'rules' | 'actions' | 'history'>('profile')

  // Форми
  const [addForm, setAddForm] = useState({ phone: '', password: '', full_name: '', role: 'cashier' as UserRole, base_rate: '' })
  const [editForm, setEditForm] = useState({ role: 'cashier' as UserRole, is_active: true, full_name: '', base_rate: '' })
  const [newPass, setNewPass] = useState('')
  const [pinInput, setPinInput] = useState('')

  // Форма створення правила комісії
  const [ruleForm, setRuleForm] = useState({
    brand_id: '',
    category_id: '',
    rule_type: 'personal_sales',
    pct_from_revenue: '',
    pct_from_profit: '',
  })

  // Форма швидкої дії (ЗП)
  const [actionForm, setActionForm] = useState({
    type: 'salary' as 'salary' | 'bonus' | 'advance' | 'penalty',
    method: 'cash' as 'cash' | 'card' | 'transfer',
    amount: '',
    note: '',
    period: currentPeriod(),
  })

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [usersRes, summaryRes, paymentsRes, rulesRes, brandsRes, categoriesRes] = await Promise.all([
        adminApi.listUsers(),
        api.get<{ data: EmployeeSummary[] }>(`/api/v1/salary/summary?period=${period}`),
        api.get<{ data: SalaryPayment[] }>(`/api/v1/salary?period=${period}`),
        commissionApi.listRules(),
        adminApi.listBrands(),
        adminApi.listCategories(),
      ])
      setUsers(usersRes.data)
      setSummary(summaryRes.data ?? [])
      setPayments(paymentsRes.data ?? [])
      setRules(rulesRes.data ?? [])
      setBrands(brandsRes.data ?? [])
      setCategories(categoriesRes.data ?? [])
    } catch {
      toast.error('Помилка завантаження даних')
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Періоди
  function shiftPeriod(delta: number) {
    const [y, m] = period.split('-').map(Number)
    const d = new Date(y, m - 1 + delta, 1)
    setPeriod(d.toISOString().slice(0, 7))
  }

  // Створення співробітника
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      await adminApi.createUser({
        ...addForm,
        base_rate: addForm.base_rate ? Math.round(parseFloat(addForm.base_rate) * 100) : 0
      })
      toast.success('Співробітника додано')
      setAddOpen(false)
      setAddForm({ phone: '', password: '', full_name: '', role: 'cashier', base_rate: '' })
      loadData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка створення')
    } finally {
      setSaving(false)
    }
  }

  // Відкрити Drawer співробітника
  function openDrawer(u: AdminUser) {
    setSelectedUser(u)
    setEditForm({
      role: u.role as UserRole,
      is_active: u.is_active,
      full_name: u.full_name,
      base_rate: u.base_rate ? (u.base_rate / 100).toString() : ''
    })
    setNewPass('')
    setPinInput('')
    setDrawerTab('profile')
    // Очищуємо форму транзакції під цього працівника
    setActionForm({
      type: 'salary',
      method: 'cash',
      amount: u.base_rate ? (u.base_rate / 100).toString() : '',
      note: '',
      period: period,
    })
  }

  // Зберегти профіль
  async function handleEditProfile(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedUser) return
    setSaving(true)
    try {
      await adminApi.updateUser(selectedUser.id, {
        ...editForm,
        base_rate: editForm.base_rate ? Math.round(parseFloat(editForm.base_rate) * 100) : 0
      })
      toast.success('Профіль оновлено')
      loadData()
      // Оновити поточного вибраного користувача в Drawer
      setSelectedUser({
        ...selectedUser,
        role: editForm.role,
        is_active: editForm.is_active,
        full_name: editForm.full_name,
        base_rate: editForm.base_rate ? Math.round(parseFloat(editForm.base_rate) * 100) : 0
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка')
    } finally {
      setSaving(false)
    }
  }

  // Зберегти лише ставку (з вкладки зарплати — щоб не шукати її в редагуванні профілю)
  async function handleSaveRate() {
    if (!selectedUser) return
    setSaving(true)
    try {
      const rate = editForm.base_rate ? Math.round(parseFloat(editForm.base_rate) * 100) : 0
      await adminApi.updateUser(selectedUser.id, {
        role: selectedUser.role as UserRole,
        is_active: selectedUser.is_active,
        full_name: selectedUser.full_name,
        base_rate: rate,
      })
      toast.success('Ставку збережено')
      setSelectedUser({ ...selectedUser, base_rate: rate })
      loadData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка')
    } finally {
      setSaving(false)
    }
  }

  // Скинути пароль
  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedUser || newPass.length < 6) {
      toast.error('Мінімум 6 символів')
      return
    }
    setSaving(true)
    try {
      await adminApi.resetPassword(selectedUser.id, newPass)
      toast.success('Пароль успішно змінено')
      setNewPass('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка')
    } finally {
      setSaving(false)
    }
  }

  // Зберегти PIN
  async function handleSetPin() {
    if (pinInput.length !== 4) {
      toast.error('PIN-код має складатися з 4 цифр')
      return
    }
    if (!selectedUser) return
    try {
      await api.post('/api/v1/auth/set-pin', { user_id: selectedUser.id, pin: pinInput })
      toast.success('PIN-код збережено')
      setPinInput('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка PIN')
    }
  }

  // Видалення співробітника
  async function handleDeleteUser() {
    if (!deleteConfirmUser) return
    setSaving(true)
    try {
      await adminApi.deleteUser(deleteConfirmUser.id)
      toast.success('Співробітника видалено')
      setDeleteConfirmUser(null)
      loadData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка при видаленні')
    } finally {
      setSaving(false)
    }
  }

  // Додавання правила комісії
  async function handleAddRule(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedUser) return
    const pctRev = Number(ruleForm.pct_from_revenue) || 0
    const pctProf = Number(ruleForm.pct_from_profit) || 0

    if (pctRev === 0 && pctProf === 0) {
      toast.error('Вкажіть хоча б один відсоток комісії')
      return
    }

    setSaving(true)
    try {
      await commissionApi.createRule({
        user_id: selectedUser.id,
        brand_id: ruleForm.brand_id || null,
        category_id: ruleForm.category_id || null,
        pct_from_revenue: pctRev,
        pct_from_profit: pctProf,
        rule_type: ruleForm.rule_type,
      })
      toast.success('Правило комісії додано')
      setRuleForm({ brand_id: '', category_id: '', rule_type: 'personal_sales', pct_from_revenue: '', pct_from_profit: '' })
      loadData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка створення правила')
    } finally {
      setSaving(false)
    }
  }

  // Видалення правила комісії
  async function handleDeleteRule(id: string) {
    try {
      await commissionApi.deleteRule(id)
      toast.success('Правило видалено')
      loadData()
    } catch {
      toast.error('Помилка видалення')
    }
  }

  // Додавання транзакції (нарахування/виплата)
  async function handleAddTransaction() {
    if (!selectedUser) return
    const amount = Math.round(parseFloat(actionForm.amount || '0') * 100)
    if (amount <= 0) {
      toast.error('Вкажіть коректну суму')
      return
    }

    setSaving(true)
    try {
      await api.post('/api/v1/salary', {
        employee_id: selectedUser.id,
        employee_name: selectedUser.full_name || selectedUser.email,
        amount,
        type: actionForm.type,
        method: actionForm.method,
        period: actionForm.period || period,
        note: actionForm.note.trim() || null,
      })
      toast.success('Транзакцію успішно записано')
      setActionForm((prev) => ({ ...prev, amount: '', note: '' }))
      loadData()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка')
    } finally {
      setSaving(false)
    }
  }

  // Видалення транзакції
  async function handleDeleteTransaction(id: string) {
    try {
      await api.delete(`/api/v1/salary/${id}`)
      toast.success('Запис видалено')
      loadData()
    } catch {
      toast.error('Помилка видалення запису')
    }
  }

  // Допоміжні функції резолвінгу імен
  function getCategoryName(id: string | null) {
    if (!id) return 'Всі категорії'
    return categories.find((c) => c.id === id)?.name ?? 'Невідома категорія'
  }

  function getBrandName(id: string | null) {
    if (!id) return 'Всі бренди'
    return brands.find((b) => b.id === id)?.name ?? 'Невідомий бренд'
  }

  // Рендер колонок таблиці
  const columns = [
    { key: 'name', header: 'Співробітник', render: (u: AdminUser) => (
      <div>
        <div className="font-semibold text-gray-900">{u.full_name || '—'}</div>
        <div className="text-xs text-gray-400 font-mono">{u.phone}</div>
      </div>
    )},
    { key: 'role', header: 'Роль', render: (u: AdminUser) => (
      <Badge color={ROLE_COLORS[u.role as UserRole] ?? 'gray'}>
        {ROLE_LABELS[u.role as UserRole] ?? u.role}
      </Badge>
    )},
    { key: 'base_rate', header: 'Ставка', render: (u: AdminUser) => (
      <span className="font-medium text-gray-700">
        {u.base_rate > 0 ? formatMoney(u.base_rate) : '—'}
      </span>
    )},
    { key: 'earned', header: 'Нараховано', render: (u: AdminUser) => {
      const sum = summary.find((s) => s.employee_id === u.id)
      return <span className="text-green-600 font-medium">{sum && sum.earned > 0 ? formatMoney(sum.earned) : '—'}</span>
    }},
    { key: 'paid', header: 'Виплачено', render: (u: AdminUser) => {
      const sum = summary.find((s) => s.employee_id === u.id)
      return <span className="text-gray-500 font-medium">{sum && sum.paid > 0 ? formatMoney(sum.paid) : '—'}</span>
    }},
    { key: 'penalty', header: 'Штрафи', render: (u: AdminUser) => {
      const sum = summary.find((s) => s.employee_id === u.id)
      return <span className="text-red-500 font-medium">{sum && sum.penalty > 0 ? formatMoney(sum.penalty) : '—'}</span>
    }},
    { key: 'balance', header: 'До виплати', render: (u: AdminUser) => {
      const sum = summary.find((s) => s.employee_id === u.id)
      if (!sum || sum.balance === 0) return <span className="text-gray-400">—</span>
      return (
        <span className={`font-bold ${sum.balance > 0 ? 'text-green-700' : 'text-red-600'}`}>
          {formatMoney(sum.balance)}
        </span>
      )
    }},
    { key: 'status', header: 'Статус', render: (u: AdminUser) => (
      <Badge color={u.is_active ? 'green' : 'red'}>
        {u.is_active ? 'Активний' : 'Заблокований'}
      </Badge>
    )},
    { key: 'actions', header: '', className: 'text-right', render: (u: AdminUser) => (
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={() => openDrawer(u)}>
          Керувати
        </Button>
        <button onClick={() => setDeleteConfirmUser(u)}
          className="p-1.5 text-gray-400 hover:text-red-600 rounded-lg hover:bg-red-50 transition-colors"
          title="Видалити">
          <Trash2 size={14} />
        </button>
      </div>
    )},
  ]

  // Фільтр транзакцій для Drawer
  const employeePayments = payments.filter((p) => selectedUser && p.employee_id === selectedUser.id)
  const employeeRules = rules.filter((r) => selectedUser && r.user_id === selectedUser.id)

  const selectedUserSummary = selectedUser
    ? summary.find((s) => s.employee_id === selectedUser.id) || { earned: 0, paid: 0, penalty: 0, balance: 0 }
    : { earned: 0, paid: 0, penalty: 0, balance: 0 }

  return (
    <Layout title="Команда та ЗП">
      <div className="max-w-6xl space-y-4">
        
        {/* Панель керування періодами */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-white p-4 rounded-xl border border-gray-100">
          <div className="flex items-center gap-2">
            <button onClick={() => shiftPeriod(-1)} className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm hover:bg-gray-50 transition-colors">←</button>
            <span className="font-semibold text-gray-800 text-md min-w-[120px] text-center">{periodLabel(period)}</span>
            <button onClick={() => shiftPeriod(1)} className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm hover:bg-gray-50 transition-colors">→</button>
          </div>
          
          <div className="flex items-center gap-4 w-full sm:w-auto justify-between sm:justify-end">
            <p className="text-xs text-gray-500">Всього співробітників: <span className="font-semibold text-gray-900">{users.length}</span></p>
            <Button icon={<Plus size={16} />} onClick={() => setAddOpen(true)}>
              Додати співробітника
            </Button>
          </div>
        </div>

        {/* Головна таблиця */}
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

      {/* Drawer (Бічна панель співробітника) */}
      {selectedUser && (
        <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex justify-end transition-opacity duration-300">
          {/* Клік по оверлею закриває Drawer */}
          <div className="flex-1" onClick={() => setSelectedUser(null)}></div>
          
          <div className="bg-white w-full max-w-xl h-full shadow-2xl flex flex-col p-6 overflow-y-auto z-50 relative animate-slide-in">
            {/* Кнопка закриття */}
            <button
              onClick={() => setSelectedUser(null)}
              className="absolute top-4 right-4 p-2 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-50 transition-all"
            >
              <X size={20} />
            </button>

            {/* Заголовок */}
            <div className="mb-6">
              <h2 className="text-xl font-bold text-gray-900">{selectedUser.full_name || 'Без імені'}</h2>
              <p className="text-xs text-gray-500 font-mono mt-1">{selectedUser.phone} · {ROLE_LABELS[selectedUser.role as UserRole] || selectedUser.role}</p>
            </div>

            {/* Вкладки */}
            <div className="flex border-b border-gray-100 mb-6 gap-4 text-sm font-medium">
              <button
                onClick={() => setDrawerTab('profile')}
                className={`pb-2 border-b-2 transition-colors ${drawerTab === 'profile' ? 'border-[#FFD000] text-gray-900 font-semibold' : 'border-transparent text-gray-500'}`}
              >
                Акаунт
              </button>
              <button
                onClick={() => setDrawerTab('rules')}
                className={`pb-2 border-b-2 transition-colors ${drawerTab === 'rules' ? 'border-[#FFD000] text-gray-900 font-semibold' : 'border-transparent text-gray-500'}`}
              >
                ЗП та Комісії
              </button>
              <button
                onClick={() => setDrawerTab('actions')}
                className={`pb-2 border-b-2 transition-colors ${drawerTab === 'actions' ? 'border-[#FFD000] text-gray-900 font-semibold' : 'border-transparent text-gray-500'}`}
              >
                Нарахувати/Виплатити
              </button>
              <button
                onClick={() => setDrawerTab('history')}
                className={`pb-2 border-b-2 transition-colors ${drawerTab === 'history' ? 'border-[#FFD000] text-gray-900 font-semibold' : 'border-transparent text-gray-500'}`}
              >
                Історія ({employeePayments.length})
              </button>
            </div>

            {/* Контент вкладок */}
            <div className="flex-1 flex flex-col min-h-0">
              
              {/* Вкладка 1: Профіль / Акаунт */}
              {drawerTab === 'profile' && (
                <div className="space-y-6">
                  {/* Основне редагування */}
                  <form onSubmit={handleEditProfile} className="space-y-4">
                    <h3 className="text-sm font-bold text-gray-800 border-b pb-2">Редагування профілю</h3>
                    <Input
                      label="Повне ім'я"
                      value={editForm.full_name}
                      onChange={(e) => setEditForm({ ...editForm, full_name: e.target.value })}
                      required
                    />
                    
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Роль *</label>
                        <select
                          value={editForm.role}
                          onChange={(e) => setEditForm({ ...editForm, role: e.target.value as UserRole })}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                        >
                          {Object.entries(ROLE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </div>
                      <Input
                        label="Ставка (грн/місяць)"
                        type="number" min="0" step="0.01"
                        value={editForm.base_rate}
                        onChange={(e) => setEditForm({ ...editForm, base_rate: e.target.value })}
                        placeholder="наприклад: 15000"
                      />
                    </div>

                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        id="edit_active_drawer"
                        checked={editForm.is_active}
                        onChange={(e) => setEditForm({ ...editForm, is_active: e.target.checked })}
                        className="w-4 h-4 rounded text-yellow-500 focus:ring-accent"
                      />
                      <label htmlFor="edit_active_drawer" className="text-sm text-gray-700 font-medium">Активний акаунт (дозволити вхід)</label>
                    </div>

                    <Button type="submit" loading={saving} className="w-full">Зберегти профіль</Button>
                  </form>

                  {/* Встановлення PIN-коду */}
                  <div className="space-y-3 bg-gray-50 p-4 rounded-xl border border-gray-100">
                    <h3 className="text-sm font-bold text-gray-800">PIN-код для входу в касу (POS)</h3>
                    <p className="text-xs text-gray-400">Швидкий вхід на касовому терміналі без повноцінного пароля.</p>
                    <div className="flex gap-2">
                      <input
                        type="text" maxLength={4} pattern="[0-9]*" inputMode="numeric"
                        value={pinInput}
                        onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 4))}
                        placeholder="0000"
                        className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono text-center text-lg tracking-widest focus:outline-none focus:ring-2 focus:ring-accent"
                      />
                      <Button onClick={handleSetPin}>Зберегти PIN</Button>
                    </div>
                  </div>

                  {/* Скидання пароля */}
                  <form onSubmit={handleResetPassword} className="space-y-3 bg-gray-50 p-4 rounded-xl border border-gray-100">
                    <h3 className="text-sm font-bold text-gray-800">Скинути пароль входу</h3>
                    <p className="text-xs text-gray-400">Встановіть новий пароль для входу в особистий кабінет працівника.</p>
                    <div className="flex gap-2">
                      <Input
                        type="password"
                        value={newPass}
                        onChange={(e) => setNewPass(e.target.value)}
                        placeholder="Мінімум 6 символів"
                        required
                        className="flex-1"
                      />
                      <Button type="submit" loading={saving} variant="secondary">Зберегти</Button>
                    </div>
                  </form>
                </div>
              )}

              {/* Вкладка 2: Зарплата та Комісії */}
              {drawerTab === 'rules' && (
                <div className="space-y-6">
                  {/* Баланс за обраний місяць */}
                  <div className="bg-yellow-50/50 p-4 rounded-xl border border-yellow-100/60 grid grid-cols-2 gap-4">
                    <div>
                      <span className="text-xs text-gray-400">Нараховано за {periodLabel(period)}</span>
                      <p className="text-lg font-bold text-green-700 mt-0.5">{formatMoney(selectedUserSummary.earned)}</p>
                    </div>
                    <div>
                      <span className="text-xs text-gray-400">Виплачено / Аванси</span>
                      <p className="text-lg font-bold text-gray-800 mt-0.5">{formatMoney(selectedUserSummary.paid)}</p>
                    </div>
                    <div>
                      <span className="text-xs text-gray-400">Штрафи</span>
                      <p className="text-lg font-bold text-red-500 mt-0.5">{formatMoney(selectedUserSummary.penalty)}</p>
                    </div>
                    <div>
                      <span className="text-xs text-gray-400">До сплати (Борг)</span>
                      <p className={`text-lg font-extrabold mt-0.5 ${selectedUserSummary.balance > 0 ? 'text-green-700' : selectedUserSummary.balance < 0 ? 'text-red-600' : 'text-gray-500'}`}>
                        {formatMoney(selectedUserSummary.balance)}
                      </p>
                    </div>
                  </div>

                  {/* Ставка — тут же, де призначаються відсотки, щоб не шукати в профілі */}
                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 space-y-2">
                    <h3 className="text-sm font-bold text-gray-800 flex items-center gap-1.5">
                      💵 Ставка (грн/місяць)
                    </h3>
                    <div className="flex gap-2 items-center">
                      <input
                        type="number" min="0" step="0.01"
                        value={editForm.base_rate}
                        onChange={(e) => setEditForm({ ...editForm, base_rate: e.target.value })}
                        placeholder="0.00"
                        className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm font-semibold text-right focus:outline-none focus:ring-2 focus:ring-yellow-400"
                      />
                      <Button size="sm" loading={saving} onClick={handleSaveRate}>Зберегти</Button>
                    </div>
                    <p className="text-[11px] text-gray-400">
                      Фіксована частина зарплати. Відсотки з продажів додаються зверху — правилами нижче.
                    </p>
                  </div>

                  {/* Додавання правила комісії */}
                  <form onSubmit={handleAddRule} className="space-y-4 bg-gray-50 p-4 rounded-xl border border-gray-100">
                    <h3 className="text-sm font-bold text-gray-800 flex items-center gap-1.5">
                      <Percent size={15} className="text-yellow-500" /> Додати відсоток (комісію)
                    </h3>
                    
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Категорія</label>
                        <select
                          value={ruleForm.category_id}
                          onChange={(e) => setRuleForm({ ...ruleForm, category_id: e.target.value })}
                          className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
                        >
                          <option value="">Всі категорії</option>
                          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </div>
                      
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Бренд</label>
                        <select
                          value={ruleForm.brand_id}
                          onChange={(e) => setRuleForm({ ...ruleForm, brand_id: e.target.value })}
                          className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
                        >
                          <option value="">Всі бренди</option>
                          {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Тип розрахунку</label>
                        <select
                          value={ruleForm.rule_type}
                          onChange={(e) => setRuleForm({ ...ruleForm, rule_type: e.target.value })}
                          className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-accent"
                        >
                          <option value="personal_sales">Власні продажі</option>
                          <option value="total_cashbox">Загальна каса</option>
                        </select>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          label="% від виручки"
                          type="number" min="0" max="100" step="0.1"
                          value={ruleForm.pct_from_revenue}
                          onChange={(e) => setRuleForm({ ...ruleForm, pct_from_revenue: e.target.value })}
                          placeholder="0"
                          className="text-xs"
                        />
                        <Input
                          label="% від прибутку"
                          type="number" min="0" max="100" step="0.1"
                          value={ruleForm.pct_from_profit}
                          onChange={(e) => setRuleForm({ ...ruleForm, pct_from_profit: e.target.value })}
                          placeholder="0"
                          className="text-xs"
                        />
                      </div>
                    </div>

                    <Button type="submit" size="sm" loading={saving} className="w-full">
                      Додати правило
                    </Button>
                  </form>

                  {/* Список правил */}
                  <div className="space-y-2">
                    <h3 className="text-sm font-bold text-gray-800">Активні правила комісії</h3>
                    {employeeRules.length === 0 ? (
                      <p className="text-xs text-gray-400 text-center py-4 bg-gray-50/50 rounded-lg border border-dashed">Немає індивідуальних правил</p>
                    ) : (
                      <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-50 bg-white">
                        {employeeRules.map((r) => (
                          <div key={r.id} className="p-3 flex items-center justify-between hover:bg-gray-50/30 transition-colors">
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-gray-900 truncate">
                                {getCategoryName(r.category_id)} · {getBrandName(r.brand_id)}
                              </p>
                              <div className="flex gap-2 text-[10px] text-gray-400 mt-1">
                                <span className="px-1 py-0.5 rounded bg-gray-100 font-medium">
                                  {r.rule_type === 'total_cashbox' ? 'Каса' : 'Особисті продажі'}
                                </span>
                                {r.pct_from_revenue > 0 && <span>Виручка: <strong className="text-gray-600">{r.pct_from_revenue}%</strong></span>}
                                {r.pct_from_profit > 0 && <span>Прибуток: <strong className="text-gray-600">{r.pct_from_profit}%</strong></span>}
                              </div>
                            </div>
                            <button
                              onClick={() => handleDeleteRule(r.id)}
                              className="text-gray-300 hover:text-red-500 p-1 rounded transition-colors"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Вкладка 3: Швидкі дії */}
              {drawerTab === 'actions' && (
                <div className="space-y-4 bg-gray-50 p-4 rounded-xl border border-gray-100">
                  <h3 className="text-sm font-bold text-gray-800">Нарахувати або виплатити</h3>
                  
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Тип операції</label>
                      <select
                        value={actionForm.type}
                        onChange={(e) => setActionForm({ ...actionForm, type: e.target.value as any })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                      >
                        <option value="salary">Ставка (Нарахування)</option>
                        <option value="bonus">Премія / Бонус (Нарахування)</option>
                        <option value="advance">Виплата / Аванс (Видача грошей)</option>
                        <option value="penalty">Штраф (Утримання)</option>
                      </select>
                    </div>
                    
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Метод</label>
                      <select
                        value={actionForm.method}
                        onChange={(e) => setActionForm({ ...actionForm, method: e.target.value as any })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                      >
                        <option value="cash">Готівка</option>
                        <option value="card">Картка</option>
                        <option value="transfer">Переказ</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <Input
                      label="Сума (грн)"
                      type="number" min="0.01" step="0.01"
                      value={actionForm.amount}
                      onChange={(e) => setActionForm({ ...actionForm, amount: e.target.value })}
                      placeholder="0.00"
                    />
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Період (місяць)</label>
                      <input
                        type="month"
                        value={actionForm.period}
                        onChange={(e) => setActionForm({ ...actionForm, period: e.target.value })}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Примітка</label>
                    <textarea
                      value={actionForm.note}
                      onChange={(e) => setActionForm({ ...actionForm, note: e.target.value })}
                      rows={3}
                      placeholder="Наприклад: Видача залишку зарплати за травень..."
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent resize-none"
                    />
                  </div>

                  <Button onClick={handleAddTransaction} loading={saving} className="w-full">
                    Зберегти операцію
                  </Button>
                </div>
              )}

              {/* Вкладка 4: Історія */}
              {drawerTab === 'history' && (
                <div className="flex-1 flex flex-col min-h-0">
                  <div className="mb-3 flex justify-between items-center shrink-0">
                    <h3 className="text-sm font-bold text-gray-800">Усі операції за {periodLabel(period)}</h3>
                  </div>
                  
                  <div className="flex-1 overflow-y-auto border border-gray-100 rounded-xl divide-y divide-gray-50 bg-white min-h-[200px]">
                    {employeePayments.length === 0 ? (
                      <p className="text-xs text-gray-400 text-center py-12">Операцій у цьому місяці ще не було</p>
                    ) : (
                      employeePayments.map((p) => {
                        const conf = TYPE_CONFIG[p.type]
                        const isMinus = p.type === 'penalty' || p.type === 'advance'
                        return (
                          <div key={p.id} className="p-3.5 flex items-start gap-3 hover:bg-gray-50/20 transition-all">
                            <div className="flex-1 min-w-0 space-y-0.5">
                              <div className="flex items-center gap-2">
                                <span className={`inline-flex items-center gap-0.5 text-[10px] font-semibold px-2 py-0.5 rounded-full ${conf.color}`}>
                                  {conf.icon} {conf.label}
                                </span>
                                <span className="text-[10px] text-gray-400">{METHOD_LABELS[p.method]}</span>
                                <span className="text-[10px] text-gray-400 font-mono">{new Date(p.created_at).toLocaleDateString('uk-UA')}</span>
                              </div>
                              {p.note && <p className="text-xs text-gray-600 leading-relaxed font-medium break-all">{p.note}</p>}
                            </div>
                            
                            <div className="text-right shrink-0 flex items-center gap-3">
                              <div>
                                <p className={`text-sm font-bold ${isMinus ? 'text-red-500' : 'text-green-600'}`}>
                                  {isMinus ? '−' : '+'}{formatMoney(p.amount)}
                                </p>
                              </div>
                              <button
                                onClick={() => handleDeleteTransaction(p.id)}
                                className="text-gray-300 hover:text-red-500 p-1 rounded transition-colors"
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>
      )}

      {/* Модалка: додати співробітника */}
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
          <Input label="Ставка (грн/місяць)" type="number" min="0" step="0.01" value={addForm.base_rate}
            onChange={(e) => setAddForm((f) => ({ ...f, base_rate: e.target.value }))}
            placeholder="наприклад: 15000" />
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
