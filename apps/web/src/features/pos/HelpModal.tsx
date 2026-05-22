import { X, Keyboard } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
}

const SHORTCUTS = [
  { key: 'F1', label: 'Довідка (це вікно)' },
  { key: 'F2', label: 'Фокус на пошук' },
  { key: 'F3', label: 'Нова вкладка чека' },
  { key: 'F5', label: 'Відкласти чек' },
  { key: 'F6', label: 'Відкладені чеки' },
  { key: 'F8', label: 'Оплата / Завершити продаж' },
  { key: 'Enter', label: 'Додати перший результат пошуку' },
  { key: '+ / -', label: 'Збільшити / зменшити кількість' },
  { key: 'Delete', label: 'Видалити товар з чека' },
  { key: 'Escape', label: 'Очистити пошук / Закрити вікно' },
]

export function HelpModal({ open, onClose }: Props) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative bg-[#1A1A1A] rounded-2xl border border-gray-700 w-full max-w-md mx-4 p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <Keyboard size={20} className="text-yellow-400" />
            <h2 className="text-white text-lg font-bold">Гарячі клавіші</h2>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-1">
          {SHORTCUTS.map((s) => (
            <div key={s.key} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-[#2C2C2C] transition-colors">
              <span className="text-gray-300 text-sm">{s.label}</span>
              <kbd className="bg-[#2C2C2C] text-yellow-400 font-mono text-xs px-2.5 py-1 rounded-lg border border-gray-700 min-w-[40px] text-center">
                {s.key}
              </kbd>
            </div>
          ))}
        </div>

        <p className="text-gray-600 text-xs text-center mt-5">
          Натисніть <kbd className="bg-[#2C2C2C] text-gray-300 font-mono px-1.5 py-0.5 rounded border border-gray-700">F1</kbd> щоб відкрити це вікно знову
        </p>
      </div>
    </div>
  )
}
