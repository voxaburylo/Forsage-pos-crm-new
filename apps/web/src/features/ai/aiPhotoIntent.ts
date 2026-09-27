/** Photos default to receiving, unless the user explicitly asks for a customer order. */
export function isOrderPhotoRequest(message: string): boolean {
  const text = message.toLocaleLowerCase('uk-UA')
  // An invoice is still receiving when the comment mentions an order or its supplier.
  if (/наклад|приход|прибутков|поступлен|постачаль|поставщик/.test(text)) return false
  return /замовлен|заказ|зошит|тетрад|\bvin\b|він.?код|вин.?код|техпаспорт|тех.?паспорт/.test(text)
}

export function isSupplyRecognitionRequest(input: { invoiceMode: boolean; hasTable: boolean; hasImages: boolean; message: string }): boolean {
  return input.invoiceMode || input.hasTable || (input.hasImages && !isOrderPhotoRequest(input.message))
}

// Always sent, including when the user supplies a short comment instead of the default prompt.
export const SUPPLY_PHOTO_INSTRUCTION = 'Це розбір прихідної накладної постачальника, не каталогу продажів. ' +
  'Розпізнай усі товарні рядки: name, brand_name, sku, barcode, qty, purchase_price_uah, category_name. ' +
  'Колонка «№» або послідовність 1, 2, 3 — це номери рядків, НЕ артикули: якщо справжнього артикула немає, sku має бути порожнім. ' +
  'Колонка «Ціна» — закупівельна ціна за одиницю purchase_price_uah, НЕ роздрібна і НЕ сума рядка. ' +
  'Кількість бери лише з колонки кількості; не підставляй 1 або 0, якщо її не видно. ' +
  'Бренд перенеси в brand_name, коли він явно є в назві (наприклад Doublestar, Rydanz, Premiorri), не вигадуй його. ' +
  'Не вигадуй артикули, штрихкоди чи ціни. Не створюй товари або рух залишків напряму. ' +
  'Продаж розрахує локальна програма за таблицею націнок; після перевірки користувач отримає чернетку накладної.'
