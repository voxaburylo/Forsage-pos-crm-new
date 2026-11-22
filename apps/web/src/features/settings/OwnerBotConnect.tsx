import { useState } from 'react'
import { api } from '@/lib/api'
import { OwnerAlertThresholds } from './OwnerAlertThresholds'

/**
 * Підключення бота власника (етап 11, 22.11.2026). Одна кнопка: сервер реєструє бота в Telegram і повертає його ім'я.
 * Далі власник пише боту /id, вставляє номер у поле вище й зберігає налаштування.
 */
export function OwnerBotConnect() {
  const [state, setState] = useState<{ busy: boolean; bot: string; error: string }>({ busy: false, bot: '', error: '' })
  async function connect() {
    if (state.busy) return
    setState({ busy: true, bot: '', error: '' })
    try {
      const { data } = await api.post<{ data: { bot_username: string } }>('/api/v1/settings/telegram-connect', {}, undefined, { silent: true, timeoutMs: 30_000 })
      setState({ busy: false, bot: data.bot_username || 'бот', error: '' })
    } catch (error) {
      setState({ busy: false, bot: '', error: (error as { message?: string })?.message || 'Не вдалося підключити бота. Перевірте інтернет і спробуйте ще раз.' })
    }
  }
  return (
    <div className="mt-3 rounded-lg bg-gray-50 px-3 py-3 text-xs text-gray-600">
      <p className="font-medium text-gray-800">Тривоги власнику в Telegram</p>
      <p className="mt-1">Крім вечірнього звіту бот напише, якщо каса не в мережі в робочий час, зміну довго не закрито, товар продано в мінус, є різниця каси або давно не було хмарної копії. Пороги — нижче.</p>
      <button type="button" onClick={() => { void connect() }} disabled={state.busy}
        className="mt-2 rounded-lg bg-yellow-400 px-3 py-2 text-xs font-semibold text-gray-900 hover:bg-yellow-300 disabled:opacity-50">
        {state.busy ? 'Підключаю…' : 'Підключити бота'}
      </button>
      {state.bot && (
        <p role="status" className="mt-2 text-green-700">
          Бота @{state.bot} підключено. Напишіть йому в Telegram <b>/id</b>, вставте отриманий номер у поле вище й натисніть «Зберегти». Перевірка: команда <b>/tryvogy</b>.
        </p>
      )}
      {state.error && <p role="alert" className="mt-2 text-red-600">{state.error}</p>}
      <OwnerAlertThresholds />
    </div>
  )
}
