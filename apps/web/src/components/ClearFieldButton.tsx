import { X } from 'lucide-react'

/**
 * 26.11.2026, слово власника: «після зчитування штрихкод лишається введений, і стирати його треба стрілочкою по одній
 * цифрі — незручно; хочу однією кнопкою, типу хрестик».
 * Хрестик у полі пошуку: одне натискання — поле порожнє. Дія на pointerdown з preventDefault — курсор лишається
 * в полі (клавіатура телефона не ховається), наступний код одразу потрапляє туди ж.
 */
export function ClearFieldButton({ visible, onClear, className = '', size = 18 }: { visible: boolean; onClear: () => void; className?: string; size?: number }) {
  if (!visible) return null
  return (
    <button type="button" data-clear-field aria-label="Очистити поле" title="Очистити поле"
      onPointerDown={event => { event.preventDefault(); onClear() }}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClear() } }}
      className={`flex items-center justify-center rounded-full ${className}`}>
      <X size={size} />
    </button>
  )
}
