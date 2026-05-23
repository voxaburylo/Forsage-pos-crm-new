import { useState, useEffect } from 'react'
import { Edit2, AlertTriangle, ToggleLeft, ToggleRight } from 'lucide-react'
import { Layout } from '@/components/Layout'
import { Button, Card, Modal, Input, Table, Badge } from '@/components/ui'
import { api } from '@/lib/api'
import { toast } from '@/components/ui/Toast'

interface NotificationTemplate {
  id: string
  event_type: string
  channel: string
  title_template: string
  body_template: string
  is_active: boolean
  created_at: string
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  order_ready: 'Замовлення готове',
  order_completed: 'Замовлення виконано',
  low_stock: 'Малий залишок',
  order_overdue: 'Прострочене замовлення',
}

const CHANNEL_LABELS: Record<string, string> = {
  in_app: 'Внутрішнє (In-App)',
  telegram: 'Telegram Bot',
  sms: 'SMS Повідомлення',
}

const EVENT_TYPE_PLACEHOLDERS: Record<string, string> = {
  order_ready: 'Доступні змінні: {{order_id}}, {{customer_name}}, {{pickup_cell}}',
  order_completed: 'Доступні змінні: {{order_id}}, {{customer_name}}, {{total_price}}',
  low_stock: 'Доступні змінні: {{product_name}}, {{qty}}, {{reorder_point}}',
  order_overdue: 'Доступні змінні: {{order_id}}, {{days}}, {{customer_name}}',
}

export default function TemplateEditor() {
  const [templates, setTemplates] = useState<NotificationTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [editingTemplate, setEditingTemplate] = useState<NotificationTemplate | null>(null)
  const [form, setForm] = useState({ title_template: '', body_template: '', is_active: true })
  const [saving, setSaving] = useState(false)

  async function loadTemplates() {
    setLoading(true)
    try {
      const { data } = await api.get<{ data: NotificationTemplate[] }>('/api/v1/notifications/templates')
      setTemplates(data ?? [])
    } catch {
      toast.error('Помилка завантаження шаблонів')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadTemplates()
  }, [])

  function startEdit(tpl: NotificationTemplate) {
    setEditingTemplate(tpl)
    setForm({
      title_template: tpl.title_template,
      body_template: tpl.body_template,
      is_active: tpl.is_active,
    })
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!editingTemplate) return

    setSaving(true)
    try {
      await api.put(`/api/v1/notifications/templates/${editingTemplate.id}`, {
        title_template: form.title_template.trim(),
        body_template: form.body_template.trim(),
        is_active: form.is_active,
      })
      toast.success('Шаблон збережено')
      setEditingTemplate(null)
      loadTemplates()
    } catch {
      toast.error('Помилка збереження шаблону')
    } finally {
      setSaving(false)
    }
  }

  async function toggleActive(tpl: NotificationTemplate) {
    try {
      await api.put(`/api/v1/notifications/templates/${tpl.id}`, {
        title_template: tpl.title_template,
        body_template: tpl.body_template,
        is_active: !tpl.is_active,
      })
      toast.success(tpl.is_active ? 'Шаблон вимкнено' : 'Шаблон увімкнено')
      loadTemplates()
    } catch {
      toast.error('Помилка оновлення статусу')
    }
  }

  const columns = [
    {
      key: 'event_type',
      header: 'Подія',
      render: (tpl: NotificationTemplate) => (
        <div>
          <span className="font-semibold text-gray-900">
            {EVENT_TYPE_LABELS[tpl.event_type] ?? tpl.event_type}
          </span>
          <div className="text-xs text-gray-400 font-mono mt-0.5">{tpl.event_type}</div>
        </div>
      ),
    },
    {
      key: 'channel',
      header: 'Канал відправки',
      render: (tpl: NotificationTemplate) => (
        <Badge color={tpl.channel === 'telegram' ? 'blue' : tpl.channel === 'sms' ? 'green' : 'purple' as any}>
          {CHANNEL_LABELS[tpl.channel] ?? tpl.channel}
        </Badge>
      ),
    },
    {
      key: 'title_template',
      header: 'Заголовок',
      render: (tpl: NotificationTemplate) => (
        <span className="text-gray-700 truncate max-w-[200px] block">
          {tpl.title_template || <span className="text-gray-300 italic">немає</span>}
        </span>
      ),
    },
    {
      key: 'body_template',
      header: 'Текст повідомлення',
      render: (tpl: NotificationTemplate) => (
        <span className="text-gray-500 truncate max-w-[300px] block">
          {tpl.body_template}
        </span>
      ),
    },
    {
      key: 'is_active',
      header: 'Статус',
      className: 'w-24',
      render: (tpl: NotificationTemplate) => (
        <button onClick={() => toggleActive(tpl)} className="flex items-center gap-1.5 text-left">
          {tpl.is_active ? (
            <>
              <ToggleRight size={20} className="text-green-500" />
              <span className="text-xs text-green-700 font-medium">Активний</span>
            </>
          ) : (
            <>
              <ToggleLeft size={20} className="text-gray-400" />
              <span className="text-xs text-gray-400 font-medium">Вимкнено</span>
            </>
          )}
        </button>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-12 text-right',
      render: (tpl: NotificationTemplate) => (
        <button
          onClick={() => startEdit(tpl)}
          className="text-gray-400 hover:text-accent p-1"
          title="Редагувати шаблон"
        >
          <Edit2 size={14} />
        </button>
      ),
    },
  ]

  return (
    <Layout title="Шаблони сповіщень">
      <div className="flex flex-col gap-6">
        <div className="flex justify-between items-center">
          <p className="text-sm text-gray-500 max-w-2xl">
            Керуйте шаблонами та каналами сповіщень для різних подій у системі. Ви можете використовувати динамічні змінні {"{{змінна}}"}, які будуть замінені на реальні значення під час відправки.
          </p>
        </div>

        <Card padding="none">
          <Table
            columns={columns}
            data={templates}
            keyFn={(tpl) => tpl.id}
            loading={loading}
            empty={<p className="text-gray-400 text-sm py-12 text-center">Шаблони не знайдені</p>}
          />
        </Card>
      </div>

      <Modal
        open={editingTemplate !== null}
        onClose={() => setEditingTemplate(null)}
        title={`Редагування шаблону: ${editingTemplate ? (EVENT_TYPE_LABELS[editingTemplate.event_type] ?? editingTemplate.event_type) : ''}`}
        size="md"
      >
        {editingTemplate && (
          <form onSubmit={handleSave} className="space-y-4">
            <div className="bg-yellow-50 border border-yellow-100 rounded-lg p-3.5 flex gap-2.5 text-xs text-yellow-800">
              <AlertTriangle className="shrink-0 text-yellow-500 mt-0.5" size={16} />
              <div>
                <p className="font-semibold mb-0.5">Важливо для форматування:</p>
                <p>{EVENT_TYPE_PLACEHOLDERS[editingTemplate.event_type] ?? 'Змінні недоступні'}</p>
              </div>
            </div>

            <Input
              label="Заголовок шаблону (Title)"
              value={form.title_template}
              onChange={(e) => setForm((f) => ({ ...f, title_template: e.target.value }))}
              placeholder="Введіть заголовок сповіщення"
            />

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Текст повідомлення (Body) *
              </label>
              <textarea
                value={form.body_template}
                onChange={(e) => setForm((f) => ({ ...f, body_template: e.target.value }))}
                rows={4}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                placeholder="Введіть текст повідомлення..."
                required
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="is_active"
                checked={form.is_active}
                onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
                className="rounded border-gray-300 text-accent focus:ring-accent"
              />
              <label htmlFor="is_active" className="text-sm text-gray-700 font-medium select-none">
                Шаблон активний для відправки
              </label>
            </div>

            <div className="flex gap-3 pt-2">
              <Button type="submit" loading={saving} className="flex-1">
                Зберегти зміни
              </Button>
              <Button type="button" variant="secondary" onClick={() => setEditingTemplate(null)}>
                Скасувати
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </Layout>
  )
}
