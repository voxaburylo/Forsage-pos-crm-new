import { useState, useEffect } from 'react'
import { Plus, Trash2, Percent, User, Tag, Package, AlertCircle } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button, Card, Modal, Input, Table } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { commissionApi } from './commissionApi'
import type { CommissionRule } from './commissionApi'
import { adminApi } from '@/features/admin/adminApi'
import type { AdminUser } from '@/features/admin/adminApi'

export default function CommissionRulesPage() {
  const [rules, setRules] = useState<CommissionRule[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [brands, setBrands] = useState<{ id: string; name: string }[]>([])
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([])

  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  // Form State
  const [form, setForm] = useState({
    user_id: '',
    brand_id: '',
    category_id: '',
    pct_from_revenue: 0,
    pct_from_profit: 0,
  })

  async function loadData() {
    setLoading(true)
    try {
      const [rulesRes, usersRes, brandsRes, categoriesRes] = await Promise.all([
        commissionApi.listRules(),
        adminApi.listUsers(),
        adminApi.listBrands(),
        adminApi.listCategories(),
      ])

      setRules(rulesRes.data)
      setUsers(usersRes.data)
      setBrands(brandsRes.data)
      setCategories(categoriesRes.data)
    } catch (err: any) {
      toast.error(err instanceof Error ? err.message : 'Помилка завантаження даних')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()

    if (form.pct_from_revenue === 0 && form.pct_from_profit === 0) {
      toast.error('Вкажіть хоча б один відсоток комісії (від виручки або прибутку)')
      return
    }

    setSaving(true)
    try {
      await commissionApi.createRule({
        user_id: form.user_id || null,
        brand_id: form.brand_id || null,
        category_id: form.category_id || null,
        pct_from_revenue: Number(form.pct_from_revenue),
        pct_from_profit: Number(form.pct_from_profit),
      })

      toast.success('Правило успішно створено')
      setModalOpen(false)
      setForm({
        user_id: '',
        brand_id: '',
        category_id: '',
        pct_from_revenue: 0,
        pct_from_profit: 0,
      })
      await loadData()
    } catch (err: any) {
      toast.error(err instanceof Error ? err.message : 'Помилка створення правила')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Ви впевнені, що хочете видалити це правило комісії?')) return
    try {
      await commissionApi.deleteRule(id)
      toast.success('Правило видалено')
      await loadData()
    } catch (err: any) {
      toast.error(err instanceof Error ? err.message : 'Помилка видалення')
    }
  }

  const columns = [
    {
      key: 'manager',
      header: 'Менеджер',
      render: (r: CommissionRule) => {
        if (!r.user_id) {
          return <span className="text-gray-400 font-medium italic">Для всіх</span>
        }
        const user = users.find((u) => u.id === r.user_id)
        return (
          <div className="flex items-center gap-2">
            <User size={14} className="text-gray-400" />
            <span className="font-medium text-gray-900">{user?.full_name || 'Менеджер'}</span>
          </div>
        )
      },
    },
    {
      key: 'brand',
      header: 'Бренд',
      render: (r: CommissionRule) => {
        if (!r.brand_id) {
          return <span className="text-gray-400 italic">Будь-який</span>
        }
        const brand = brands.find((b) => b.id === r.brand_id)
        return (
          <div className="flex items-center gap-2">
            <Package size={14} className="text-gray-400" />
            <span className="text-gray-800">{brand?.name || 'Бренд'}</span>
          </div>
        )
      },
    },
    {
      key: 'category',
      header: 'Категорія',
      render: (r: CommissionRule) => {
        if (!r.category_id) {
          return <span className="text-gray-400 italic">Будь-яка</span>
        }
        const cat = categories.find((c) => c.id === r.category_id)
        return (
          <div className="flex items-center gap-2">
            <Tag size={14} className="text-gray-400" />
            <span className="text-gray-800">{cat?.name || 'Категорія'}</span>
          </div>
        )
      },
    },
    {
      key: 'pct_revenue',
      header: '% від виручки',
      render: (r: CommissionRule) => (
        <span className={r.pct_from_revenue > 0 ? 'font-semibold text-emerald-600' : 'text-gray-400'}>
          {r.pct_from_revenue > 0 ? `${r.pct_from_revenue}%` : '—'}
        </span>
      ),
    },
    {
      key: 'pct_profit',
      header: '% від прибутку',
      render: (r: CommissionRule) => (
        <span className={r.pct_from_profit > 0 ? 'font-semibold text-indigo-600' : 'text-gray-400'}>
          {r.pct_from_profit > 0 ? `${r.pct_from_profit}%` : '—'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-12 text-right',
      render: (r: CommissionRule) => (
        <button
          onClick={() => handleDelete(r.id)}
          className="text-red-400 hover:text-red-600 transition-colors p-1"
          title="Видалити правило"
        >
          <Trash2 size={16} />
        </button>
      ),
    },
  ]

  return (
    <Layout title="Правила комісійних менеджерів">
      <div className="flex flex-col gap-6">
        <div className="flex justify-between items-center">
          <p className="text-sm text-gray-500 max-w-xl">
            Налаштуйте правила нарахування бонусів менеджерам від проданих товарів. Правила застосовуються автоматично під час завершення замовлення на основі пріоритетів.
          </p>
          <Button icon={<Plus size={16} />} onClick={() => setModalOpen(true)}>
            Додати правило
          </Button>
        </div>

        <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 flex gap-3 text-sm text-blue-700">
          <AlertCircle className="shrink-0 text-blue-500 mt-0.5" size={18} />
          <div>
            <p className="font-semibold mb-1">Принцип пріоритетності (Scoring):</p>
            <p>Система шукає найбільш точне співпадіння для кожної позиції замовлення за такою вагою:</p>
            <ul className="list-disc list-inside mt-1 space-y-0.5 text-xs text-blue-600 font-mono">
              <li>Конкретний Менеджер (+100)</li>
              <li>Конкретний Бренд (+10)</li>
              <li>Конкретна Категорія (+1)</li>
            </ul>
            <p className="mt-1">
              Наприклад, правило для конкретного бренду матиме вищий пріоритет (вага 10), ніж загальне правило для всіх брендів та категорій (вага 0).
            </p>
          </div>
        </div>

        <Card padding="none">
          <Table
            columns={columns}
            data={rules}
            keyFn={(r) => r.id}
            loading={loading}
            empty={<p className="text-gray-400 text-sm">Правила комісійних ще не створені</p>}
          />
        </Card>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Нове правило комісії" size="md">
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Менеджер</label>
            <select
              value={form.user_id}
              onChange={(e) => setForm((f) => ({ ...f, user_id: e.target.value }))}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="">Для всіх менеджерів</option>
              {users
                .filter((u) => u.is_active)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name || u.phone}
                  </option>
                ))}
            </select>
            <p className="text-xs text-gray-400 mt-1">Виберіть конкретного менеджера або залиште для всіх</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Бренд</label>
              <select
                value={form.brand_id}
                onChange={(e) => setForm((f) => ({ ...f, brand_id: e.target.value }))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="">Будь-який бренд</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Категорія</label>
              <select
                value={form.category_id}
                onChange={(e) => setForm((f) => ({ ...f, category_id: e.target.value }))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="">Будь-яка категорія</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 border-t border-gray-100 pt-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                <Percent size={14} className="inline mr-1 text-emerald-600" />
                % від виручки
              </label>
              <Input
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={form.pct_from_revenue}
                onChange={(e) => setForm((f) => ({ ...f, pct_from_revenue: parseFloat(e.target.value) || 0 }))}
                placeholder="напр. 2.5"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                <Percent size={14} className="inline mr-1 text-indigo-600" />
                % від прибутку
              </label>
              <Input
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={form.pct_from_profit}
                onChange={(e) => setForm((f) => ({ ...f, pct_from_profit: parseFloat(e.target.value) || 0 }))}
                placeholder="напр. 5.0"
                required
              />
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <Button type="submit" loading={saving} className="flex-1">
              Створити правило
            </Button>
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>
              Скасувати
            </Button>
          </div>
        </form>
      </Modal>
    </Layout>
  )
}
