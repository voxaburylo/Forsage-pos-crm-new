import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  debounceMs?: number
  autoFocus?: boolean
  className?: string
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Пошук...',
  debounceMs = 250,
  autoFocus,
  className = '',
}: Props) {
  const [local, setLocal] = useState(value)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => { setLocal(value) }, [value])
  useEffect(() => () => clearTimeout(timer.current), [])

  function clearSearch() {
    clearTimeout(timer.current)
    setLocal('')
    onChange('')
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value
    setLocal(v)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => onChange(v), debounceMs)
  }

  return (
    <div className={`relative ${className}`}>
      <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
      <input
        type="text"
        value={local}
        onChange={handleChange}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && local) {
            event.preventDefault()
            clearSearch()
          }
        }}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="w-full pl-9 pr-8 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-accent"
      />
      {local && (
        <button
          type="button"
          onClick={clearSearch}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          aria-label="Очистити пошук"
          title="Очистити пошук (Esc)"
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}
