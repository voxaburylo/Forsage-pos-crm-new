import { useState, useEffect } from 'react'
import { customerApi } from './customerApi'
import type { Customer } from '@/types/customer'
import { Modal, Button, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'

interface Props {
  open: boolean
  onClose: () => void
  onCreated: (customer: Customer) => void
}

type Mode = 'search' | 'create'

function saveRecentItem(key: string, value: string) {
  if (!value) return
  try {
    const raw = localStorage.getItem(key)
    const items: string[] = raw ? JSON.parse(raw) : []
    const next = [value, ...items.filter(i => i !== value)].slice(0, 5)
    localStorage.setItem(key, JSON.stringify(next))
  } catch (err) {
    console.error('Failed to save to localStorage:', err)
  }
}

function getRecentItems(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function QuickCustomerModal({ open, onClose, onCreated }: Props) {
  const [mode, setMode]             = useState<Mode>('search')
  const [query, setQuery]           = useState('')
  const [results, setResults]       = useState<Customer[]>([])
  const [searching, setSearching]   = useState(false)

  const [phone, setPhone] = useState('')
  const [name, setName]   = useState('')
  const [saving, setSaving] = useState(false)
  const [recentPhones, setRecentPhones] = useState<string[]>([])

  // Reset state on open
  useEffect(() => {
    if (open) {
      setMode('search')
      setQuery('')
      setResults([])
      setPhone('')
      setName('')
      setRecentPhones(getRecentItems('recent_phones'))
    }
  }, [open])

  // Debounced search
  useEffect(() => {
    if (mode !== 'search' || query.trim().length < 2) {
      setResults([])
      return
    }
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const r = await customerApi.list({ search: query.trim(), per_page: 6 })
        setResults((r as { data: Customer[] }).data ?? [])
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [query, mode])

  function selectCustomer(c: Customer) {
    saveRecentItem('recent_phones', c.phone)
    onCreated(c)
    onClose()
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!phone.trim()) { toast.error("Телефон обов'язковий"); return }
    if (!name.trim())  { toast.error("Ім'я обов'язкове"); return }
    setSaving(true)
    try {
      const result = await customerApi.quickCreate(phone, name)
      const { data } = result
      toast.success(result.meta?.reused ? 'Клієнт уже є в базі — вибрано його картку' : 'Клієнта створено')
      saveRecentItem('recent_phones', phone.trim())
      onCreated(data)
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Помилка')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Клієнт" size="sm">
      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-200 -mt-1">
        {(['search', 'create'] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={
              'px-4 py-2 text-sm font-medium border-b-2 transition-colors ' +
              (mode === m
                ? 'border-yellow-400 text-yellow-700'
                : 'border-transparent text-gray-500 hover:text-gray-700')
            }
          >
            {m === 'search' ? 'Знайти' : 'Новий клієнт'}
          </button>
        ))}
      </div>

      {mode === 'search' ? (
        <div className="space-y-3">
          <Input
            label="Ім'я або телефон"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Пошук клієнта..."
            autoFocus
          />

          {recentPhones.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1 items-center">
              <span className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider">Нещодавні:</span>
              {recentPhones.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setQuery(p)}
                  className="text-[10px] bg-gray-100 hover:bg-yellow-100 text-gray-700 px-2 py-0.5 rounded-full transition font-mono border border-gray-200/50"
                >
                  {p}
                </button>
              ))}
            </div>
          )}

          {searching && (
            <p className="text-sm text-gray-400 text-center py-2">Пошук...</p>
          )}

          {!searching && query.trim().length >= 2 && results.length === 0 && (
            <div className="text-center py-4">
              <p className="text-sm text-gray-500 mb-3">Клієнта не знайдено</p>
              <Button variant="secondary" size="sm" onClick={() => {
                setPhone(query.trim())
                setMode('create')
              }}>
                Створити нового
              </Button>
            </div>
          )}

          {results.length > 0 && (
            <div className="divide-y divide-gray-100 border border-gray-200 rounded-xl overflow-hidden">
              {results.map((c) => (
                <button
                  key={c.id}
                  onClick={() => selectCustomer(c)}
                  className="w-full text-left px-4 py-3 hover:bg-yellow-50 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {c.full_name ?? '—'}
                      </p>
                      <p className="text-xs text-gray-500">{c.phone}</p>
                    </div>
                    <div className="text-right">
                      {c.price_tier && (
                        <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full font-medium">
                          {c.price_tier.name} -{c.price_tier.discount_pct}%
                        </span>
                      )}
                      {c.debt_balance > 0 && (
                        <p className="text-xs text-red-500 mt-0.5">
                          Борг: {(c.debt_balance / 100).toFixed(2)} грн
                        </p>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          <p className="text-xs text-gray-400 text-center">
            Або{' '}
            <button
              className="text-yellow-600 hover:underline"
              onClick={() => setMode('create')}
            >
              створіть нового клієнта
            </button>
          </p>
        </div>
      ) : (
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <Input
              label="Телефон *"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+380671234567"
              autoFocus
              required
            />
            {recentPhones.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-1.5 items-center">
                <span className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider">Нещодавні:</span>
                {recentPhones.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPhone(p)}
                    className="text-[10px] bg-gray-100 hover:bg-yellow-100 text-gray-700 px-2 py-0.5 rounded-full transition font-mono border border-gray-200/50"
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}
          </div>
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
            <Button type="button" variant="secondary" onClick={() => setMode('search')}>
              Назад
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}
