import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 24.11.2026: правило поза шаром перемагає будь-який клас Tailwind 4. Загальне «min-width: 0» для всього у flex
 * стерло min-w-[80px] поля «Розн. ціна» в накладній — поле стислося, ціну не можна було ввести.
 * Загальні правила оболонки, що чіпають розміри чужих елементів, живуть лише в шарі base.
 */
describe('app shell css does not override screen classes', () => {
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const start = css.indexOf('@layer base {')
  const end = css.indexOf('\n}\n', start)
  const layered = css.slice(start, end)
  const unlayered = css.slice(0, start) + css.slice(end)

  it('keeps the generic size rules inside the base layer', () => {
    expect(start).toBeGreaterThan(0)
    expect(layered).toContain('.app-main :where(.grid > *, .flex > *) { min-width: 0; }')
    expect(layered).toContain(':where(.app-main) > * { min-width: 0; max-width: 100%; }')
  })

  it('has no unlayered rule that resizes every element inside the work area', () => {
    const generic = unlayered.split('\n').filter(line => /\.app-main\s*(>\s*\*|:where\()/.test(line) && /(min|max)-width|overflow-x/.test(line))
    expect(generic).toEqual([])
  })
})
