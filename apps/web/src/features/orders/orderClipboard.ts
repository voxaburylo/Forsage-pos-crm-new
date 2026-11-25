/**
 * 25.11.2026 (власник: «прикрепить скриншот корзины… пускай будет кнопка «вставить из буфера», и когда её нажимаем
 * или просто нажимаем Ctrl+V прямо в открытом окне заказа — если фото, распознаются детали и раскладываются по местам:
 * имена до имён, артикулы до артикулов, цены, количество, склад/поставщик; или вставляется текст — так же»).
 *
 * Фото й текст ідуть одним шляхом розпізнавання кошика (помічник). Текст програма сама малює на картинці —
 * сервер і правила розпізнавання ті самі, що для скриншота. Після розпізнавання кожну позицію шукаємо в базі
 * за артикулом: є товар і він на складі — рядок «склад» з карткою та ціною продажу з програми; інакше «постачальник».
 */
import type { CartScreenshotRow } from './orderCartScreenshot'

export type ClipboardContent = { kind: 'images'; files: File[] } | { kind: 'text'; text: string } | { kind: 'empty' }

/** Вставлений текст варто розпізнавати: у ньому є хоч одна літера й він не порожній. */
export function isRecognizableText(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length >= 3 && trimmed.length <= 20_000 && /\p{L}/u.test(trimmed)
}

/** Куди вставляє людина: у поле вводу — звичайна вставка тексту, не розпізнавання. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).closest !== 'function') return false
  const element = target as HTMLElement
  return Boolean(element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))
}

/** Розбиває текст на сторінки по 60 рядків (довгі рядки переносяться), щоб помічник читав їх чітко. */
export function textPages(text: string, width = 110, linesPerPage = 60): string[][] {
  const lines: string[] = []
  for (const raw of text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
    const line = raw.replace(/\s+$/u, '')
    if (!line.trim()) { if (lines.length && lines[lines.length - 1] !== '') lines.push(''); continue }
    for (let start = 0; start < line.length; start += width) lines.push(line.slice(start, start + width))
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  const pages: string[][] = []
  for (let start = 0; start < lines.length; start += linesPerPage) pages.push(lines.slice(start, start + linesPerPage))
  return pages.slice(0, 10)
}

/** Малює текст на білому полі (PNG) — так текст проходить той самий шлях розпізнавання, що й скриншот. */
export async function textToImages(text: string): Promise<File[]> {
  const files: File[] = []
  for (const [index, page] of textPages(text).entries()) {
    const fontSize = 20, lineHeight = 28, padding = 24
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Не вдалося підготувати текст до розпізнавання')
    context.font = `${fontSize}px Consolas, "Courier New", monospace`
    const widest = Math.max(200, ...page.map(line => context.measureText(line).width))
    canvas.width = Math.min(2000, Math.ceil(widest + padding * 2))
    canvas.height = Math.min(2000, page.length * lineHeight + padding * 2)
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#000000'
    context.font = `${fontSize}px Consolas, "Courier New", monospace`
    context.textBaseline = 'top'
    page.forEach((line, row) => context.fillText(line, padding, padding + row * lineHeight))
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('Не вдалося підготувати текст до розпізнавання')
    files.push(new File([blob], `text-${index + 1}.png`, { type: 'image/png' }))
  }
  return files
}

/** Читає буфер обміну кнопкою: спершу картинки, інакше текст. Без дозволу браузера — пояснення, що натиснути Ctrl+V. */
export async function readClipboard(clipboard: Pick<Clipboard, 'read' | 'readText'> | undefined = globalThis.navigator?.clipboard): Promise<ClipboardContent> {
  if (!clipboard) throw new Error('Буфер обміну недоступний. Натисніть Ctrl+V у вікні замовлення.')
  try {
    if (typeof clipboard.read === 'function') {
      const files: File[] = []
      for (const item of await clipboard.read()) {
        const type = item.types.find(candidate => candidate.startsWith('image/'))
        if (type) files.push(new File([await item.getType(type)], 'clipboard.png', { type }))
      }
      if (files.length) return { kind: 'images', files }
    }
    const text = typeof clipboard.readText === 'function' ? await clipboard.readText() : ''
    return isRecognizableText(text) ? { kind: 'text', text } : { kind: 'empty' }
  } catch {
    throw new Error('Програма не змогла прочитати буфер обміну. Натисніть Ctrl+V у вікні замовлення.')
  }
}

/** Артикул без пробілів, дефісів, крапок і регістру — «OC 90», «oc-90» і «OC90» однакові. */
export function skuKey(value: string | null | undefined): string {
  return String(value ?? '').normalize('NFKC').toUpperCase().replace(/[\s\-./_]/g, '')
}

export type CatalogProduct = { id: string; name: string; sku?: string | null; retail_price: number; purchase_price?: number | null; qty_on_hand?: number | null; qty_available?: number | null; is_service?: boolean | null }

/**
 * Позиція знайдена в базі за точним артикулом: прив'язуємо до картки (назва з програми, ціна продажу з картки).
 * Є на складі стільки, скільки треба, — «склад»; немає або не вистачає — «постачальник» (закупка з кошика лишається).
 */
export function placeRecognizedRow<T extends CartScreenshotRow & { source_type?: 'warehouse' | 'supplier' }>(row: T, products: readonly CatalogProduct[]): T & {
  product_id?: string; sell_price?: string; stock?: number; source_type: 'warehouse' | 'supplier'
} {
  const key = skuKey(row.sku)
  const product = key.length >= 3 ? products.find(candidate => skuKey(candidate.sku) === key) : undefined
  if (!product) return { ...row, source_type: 'supplier' }
  const stock = Math.max(0, Number(product.qty_available ?? product.qty_on_hand ?? 0))
  const need = Number(row.qty) > 0 ? Number(row.qty) : 1
  const fromStock = Boolean(product.is_service) || stock >= need
  const hryvnia = (kopecks: number) => (Math.round(kopecks) / 100).toFixed(2)
  return {
    ...row,
    name: product.name || row.name,
    sku: product.sku || row.sku,
    product_id: product.id,
    stock,
    sell_price: Number(product.retail_price) > 0 ? hryvnia(Number(product.retail_price)) : '0',
    buy_price: fromStock && Number(product.purchase_price) > 0 ? hryvnia(Number(product.purchase_price)) : row.buy_price,
    source_type: fromStock ? 'warehouse' : 'supplier',
  }
}
