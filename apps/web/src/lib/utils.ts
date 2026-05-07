// Форматування грошей
export function formatMoney(kopecks: number): string {
  return (kopecks / 100).toLocaleString('uk-UA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + ' ₴'
}

// Форматування дати
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('uk-UA', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  })
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('uk-UA', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// Нормалізація артикулу (по ТЗ розділ 13.1)
export function normalizeArticle(raw: string): string {
  return raw.replace(/[\s\-\.\/\_]/g, '').toUpperCase().replace(/^0+/, '') || raw.toUpperCase()
}

// Нормалізація телефону
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('380')) return `+${digits}`
  if (digits.startsWith('80'))  return `+3${digits}`
  if (digits.startsWith('0'))   return `+38${digits}`
  return raw
}

// Скорочення довгого тексту
export function truncate(text: string, max = 50): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

// Дебоунс
export function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>
  return ((...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }) as T
}
