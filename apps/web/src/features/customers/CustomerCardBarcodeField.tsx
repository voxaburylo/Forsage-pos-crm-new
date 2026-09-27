import { useId } from 'react'

interface Props {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

export function preventCardScanSubmit(event: { key: string; preventDefault: () => void; stopPropagation: () => void }) {
  if (event.key === 'Enter') {
    event.preventDefault()
    event.stopPropagation()
  }
}

export function CustomerCardBarcodeField({ value, onChange, disabled }: Props) {
  const id = useId()
  return <div className="min-w-0 space-y-1">
    <label htmlFor={id} className="block text-sm font-medium text-gray-700">Штрихкод картки клієнта</label>
    <div className="flex flex-wrap gap-2">
      <input id={id} type="text" value={value} disabled={disabled}
        onChange={(event) => onChange(event.target.value.replace(/\s/g, ''))}
        onKeyDown={preventCardScanSubmit}
        autoComplete="off" spellCheck={false} aria-describedby={`${id}-help`}
        placeholder="Відскануйте або введіть код своєї картки"
        className="min-w-0 w-full flex-[1_1_240px] rounded-lg border border-gray-200 px-3 py-2.5 font-mono text-sm outline-none focus:ring-2 focus:ring-yellow-400" />
      <button type="button" disabled={disabled || Boolean(value)}
        onClick={() => onChange('200' + String(Math.floor(Math.random() * 1_000_000_000)).padStart(10, '0'))}
        className="shrink-0 rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600 hover:bg-gray-200 disabled:opacity-50">
        Згенерувати
      </button>
    </div>
    <p id={`${id}-help`} className="text-xs text-gray-500">Є готова картка — введіть її код. Генерація потрібна лише для нової картки.</p>
  </div>
}
