import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Save } from 'lucide-react'
import { Button, Input } from '@/components/ui'
import { toast } from '@/components/ui/Toast'
import { photoAiApi, type PhotoAiSettings, type PhotoAiStatus } from './photoAiApi'

/**
 * Налаштування → «API-ключі» → «Фото ШІ»: ключі Serper.dev (пошук картинок) і Gemini (перевірка фото) та правила пошуку.
 * Ключі вставляє лише власник; зберігає їх сервер зашифрованими, назад видно тільки чотири останні знаки.
 * Обидва сервіси платні за запит — без ключів функція нічого не шукає й нічого не витрачає.
 */
const message = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback

export function PhotoAiSettingsCard({ onChanged }: { onChanged?: () => void }) {
  const [status, setStatus] = useState<PhotoAiStatus | null>(null)
  const [error, setError] = useState('')
  const [serper, setSerper] = useState('')
  const [gemini, setGemini] = useState('')
  const [form, setForm] = useState<PhotoAiSettings | null>(null)
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try { const data = await photoAiApi.status(true); setStatus(data); setForm(data.settings); setError('') }
    catch (reason) { setError(message(reason, 'Не вдалося відкрити налаштування «Фото ШІ». Потрібен інтернет.')) }
  }, [])
  useEffect(() => { void load() }, [load])

  async function saveKey(kind: 'serper' | 'gemini', value: string) {
    setBusy(kind)
    try {
      await photoAiApi.saveKeys(kind === 'serper' ? { serper_key: value.trim() } : { gemini_key: value.trim() })
      toast.success(value.trim() ? 'Ключ збережено' : 'Ключ прибрано')
      if (kind === 'serper') setSerper(''); else setGemini('')
      await load(); onChanged?.()
    } catch (reason) { toast.error(message(reason, 'Не вдалося зберегти ключ')) } finally { setBusy('') }
  }

  async function saveSettings() {
    if (!form) return
    setBusy('settings')
    try { setForm(await photoAiApi.saveSettings(form)); toast.success('Налаштування збережено'); onChanged?.() }
    catch (reason) { toast.error(message(reason, 'Не вдалося зберегти налаштування')) } finally { setBusy('') }
  }

  if (error) return <p role="alert" className="text-sm text-red-700">{error} <button type="button" className="underline" onClick={() => void load()}>Повторити</button></p>
  if (!status || !form) return <p className="text-sm text-gray-500">Завантаження…</p>
  const keyRow = (kind: 'serper' | 'gemini', title: string, has: boolean, hint: string, value: string, set: (value: string) => void, where: string) => (
    <div className="rounded-lg border border-gray-200 p-3">
      <p className="flex items-center gap-2 text-sm font-medium"><KeyRound size={16} /> {title}
        <span className={`text-xs font-normal ${has ? 'text-green-700' : 'text-gray-500'}`}>{has ? `ключ є (${hint})` : 'ключа немає'}</span></p>
      <p className="mt-1 text-xs text-gray-500">{where}</p>
      {status.can_edit_keys ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Input type="password" autoComplete="off" value={value} onChange={event => set(event.target.value)} placeholder={has ? 'Новий ключ замість старого' : 'Вставте ключ'} className="min-w-0 flex-1" aria-label={title} />
          <Button type="button" size="sm" loading={busy === kind} disabled={!value.trim()} onClick={() => void saveKey(kind, value)}>Зберегти ключ</Button>
          {has && <Button type="button" size="sm" variant="secondary" disabled={busy === kind} onClick={() => void saveKey(kind, '')}>Прибрати</Button>}
        </div>
      ) : <p className="mt-2 text-xs text-gray-500">Ключ вставляє власник.</p>}
    </div>
  )
  const toggle = (key: 'require_white' | 'forbid_text' | 'night_only', label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={form[key]} onChange={event => setForm({ ...form, [key]: event.target.checked })} /> {label}
    </label>
  )
  return (
    <div className="space-y-3" data-photo-ai-settings>
      <p className="text-xs text-gray-500">
        Обидва сервіси платні за запит: на один товар іде 1 запит пошуку (Serper.dev) і до 6–8 перевірок фото (Gemini). Без ключів нічого не шукається.
        {' '}За сьогодні: пошук {status.usage.serper_today}, ШІ {status.usage.gemini_today}; за 30 днів: пошук {status.usage.serper_month}, ШІ {status.usage.gemini_month}.
      </p>
      {status.compressor === false && <p role="alert" className="text-sm text-red-700">На сервері не працює стиснення фото — зберегти фото не вдасться. Напишіть розробнику програми.</p>}
      {keyRow('serper', 'Serper.dev — пошук картинок Google', status.keys.serper, status.keys.serper_hint, serper, setSerper, 'Ключ береться в кабінеті serper.dev (розділ API Key).')}
      {keyRow('gemini', 'Gemini — перевірка фото', status.keys.gemini, status.keys.gemini_hint, gemini, setGemini, 'Ключ береться в Google AI Studio (aistudio.google.com → Get API key).')}
      <div className="rounded-lg border border-gray-200 p-3 space-y-2">
        <p className="text-sm font-medium">Правила пошуку</p>
        <label className="flex flex-wrap items-center gap-2 text-sm">Фото на товар
          <select value={form.photos_per_product} onChange={event => setForm({ ...form, photos_per_product: Number(event.target.value) })} className="rounded border border-gray-300 px-2 py-1">
            {[1, 2, 3, 4, 5].map(count => <option key={count} value={count}>{count}</option>)}
          </select>
          <span className="text-xs text-gray-500">перше — головне, решта — галерея для сайту</span>
        </label>
        {toggle('require_white', 'Лише білий фон')}
        {toggle('forbid_text', 'Без водяних знаків, цін і написів магазинів')}
        <label className="flex flex-wrap items-center gap-2 text-sm">Мінімальний розмір, px
          <input type="number" min={200} max={2000} step={50} value={form.min_size} onChange={event => setForm({ ...form, min_size: Number(event.target.value) || 600 })} className="w-24 rounded border border-gray-300 px-2 py-1" />
        </label>
        {toggle('night_only', 'Масовий пошук — лише вночі (22:00–07:00)')}
        <Button type="button" size="sm" loading={busy === 'settings'} onClick={() => void saveSettings()}><Save size={14} /> Зберегти правила</Button>
      </div>
    </div>
  )
}
