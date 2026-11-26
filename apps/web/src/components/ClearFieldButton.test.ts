import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// 26.11.2026, слово власника: «після зчитування штрихкод лишається введений, стирати треба по одній цифрі — незручно;
// хочу однією кнопкою, типу хрестик».
describe('one-tap clear in every search field the camera types into', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

  it('the cross keeps the cursor in the field (pointerdown + preventDefault) and shows only when there is text', () => {
    const button = read('./ClearFieldButton.tsx')
    expect(button).toContain('if (!visible) return null')
    expect(button).toContain('onPointerDown={event => { event.preventDefault(); onClear() }}')
    expect(button).toContain('aria-label="Очистити поле"')
  })

  it('till search, goods search and stock-count search all have it', () => {
    expect(read('../features/pos/SearchPanel.tsx')).toContain("<ClearFieldButton visible={query !== ''} onClear={() => { setQuery(''); inputRef.current?.focus() }}")
    expect(read('../features/products/ProductsPage.tsx')).toContain("<ClearFieldButton visible={search !== ''} onClear={() => handleSearchChange('')}")
    expect(read('../features/inventory/ActiveSession.tsx')).toContain("<ClearFieldButton visible={query !== ''} onClear={() => { setQuery(''); setSelected(null); setQuickCreateOpen(false); inputRef.current?.focus() }}")
    // Текст не заходить під хрестик і значок камери.
    expect(read('../features/products/ProductsPage.tsx')).toContain('w-full pl-9 pr-20 py-2.5')
    expect(read('../features/pos/SearchPanel.tsx')).toContain('pl-10 pr-12 rounded-xl')
  })
})
