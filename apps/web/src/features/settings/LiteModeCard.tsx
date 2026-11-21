import { useState } from 'react'
import { Gauge } from 'lucide-react'
import { Card } from '@/components/ui'
import { liteModeActive, readLiteModeSetting, saveLiteModeSetting, type LiteModeSetting } from '@/lib/liteMode'

const OPTIONS: Array<{ value: LiteModeSetting; label: string }> = [
  { value: 'auto', label: 'Автоматично' },
  { value: 'on', label: 'Увімкнено' },
  { value: 'off', label: 'Вимкнено' },
]

/** Перемикач полегшеного режиму (старий ПК на Windows 10). Діє лише на цьому ПК. */
export function LiteModeCard() {
  const [setting, setSetting] = useState<LiteModeSetting>(readLiteModeSetting)
  const [active, setActive] = useState(() => liteModeActive(setting))
  return (
    <Card className="mt-6 space-y-3">
      <div className="flex items-center gap-2 pb-3 border-b border-gray-100">
        <Gauge size={18} className="text-gray-500" />
        <h3 className="text-sm font-semibold text-gray-800">Полегшений режим для старого ПК</h3>
      </div>
      <p className="text-xs text-gray-500">Прибирає анімації, тіні й розмиття — на слабкому комп'ютері програма працює плавніше. «Автоматично» вмикає режим, якщо в ПК 4 ядра або менше чи 4 ГБ пам'яті або менше. Діє лише на цьому ПК.</p>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Полегшений режим">
        {OPTIONS.map(option => (
          <button key={option.value} type="button" role="radio" aria-checked={setting === option.value}
            onClick={() => { setSetting(option.value); setActive(saveLiteModeSetting(option.value)) }}
            className={`rounded-lg px-3 py-1.5 text-sm ${setting === option.value ? 'bg-gray-900 text-white' : 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-100'}`}>
            {option.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-gray-600">Зараз: {active ? 'увімкнено' : 'вимкнено'}.</p>
    </Card>
  )
}
