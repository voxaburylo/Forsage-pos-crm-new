import { PrintService } from '@/lib/printService'
import { formatDate } from '@/lib/utils'
import type { CustomerOrder } from './orderApi'

// ─────────────────────────────────────────────────────────────
// Реквізити продавця (зберігаються локально на пристрої).
// Редагуються в Налаштуваннях → «Реквізити продавця».
// ─────────────────────────────────────────────────────────────
export interface SellerRequisites {
  name: string      // ФОП Прізвище І.Б. / ТОВ «Назва»
  edrpou: string    // ЄДРПОУ або ІПН
  iban: string      // UA...
  bank: string      // Назва банку
  address: string   // Адреса
  phone: string     // Телефон
  director: string  // ПІБ, хто підписує (директор / ФОП)
}

const SELLER_KEY = 'forsage_seller_requisites'

export const EMPTY_SELLER: SellerRequisites = {
  name: '', edrpou: '', iban: '', bank: '', address: '', phone: '', director: '',
}

export function loadSellerRequisites(): SellerRequisites {
  try {
    const raw = localStorage.getItem(SELLER_KEY)
    if (!raw) return { ...EMPTY_SELLER }
    return { ...EMPTY_SELLER, ...JSON.parse(raw) }
  } catch {
    return { ...EMPTY_SELLER }
  }
}

export function saveSellerRequisites(value: SellerRequisites): void {
  localStorage.setItem(SELLER_KEY, JSON.stringify(value))
}

export function hasSellerRequisites(r: SellerRequisites): boolean {
  return !!(r.name.trim() || r.edrpou.trim() || r.iban.trim())
}

// ─────────────────────────────────────────────────────────────
// Грошові хелпери
// ─────────────────────────────────────────────────────────────
/** Гривні (число) → "1 234,56". Без символу валюти. */
function money(hrn: number): string {
  return hrn.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Гривні (число) для месенджера: ціле без копійок, або з комою якщо є копійки. */
function moneyShort(hrn: number): string {
  return Number.isInteger(hrn) ? String(hrn) : hrn.toFixed(2).replace('.', ',')
}

/** Групування тисяч крапкою (як у прикладі клієнта: 6280 → "6.280"). */
function groupDot(hrn: number): string {
  const whole = Math.round(hrn)
  return whole.toLocaleString('de-DE')
}

// ─── Сума прописом (гривні + копійки) українською ───
const ONES = ['', 'один', 'два', 'три', 'чотири', 'п’ять', 'шість', 'сім', 'вісім', 'дев’ять']
const ONES_F = ['', 'одна', 'дві', 'три', 'чотири', 'п’ять', 'шість', 'сім', 'вісім', 'дев’ять']
const TEENS = ['десять', 'одинадцять', 'дванадцять', 'тринадцять', 'чотирнадцять', 'п’ятнадцять', 'шістнадцять', 'сімнадцять', 'вісімнадцять', 'дев’ятнадцять']
const TENS = ['', '', 'двадцять', 'тридцять', 'сорок', 'п’ятдесят', 'шістдесят', 'сімдесят', 'вісімдесят', 'дев’яносто']
const HUNDREDS = ['', 'сто', 'двісті', 'триста', 'чотириста', 'п’ятсот', 'шістсот', 'сімсот', 'вісімсот', 'дев’ятсот']

function tripletToWords(n: number, feminine: boolean): string {
  const words: string[] = []
  const h = Math.floor(n / 100)
  const t = Math.floor((n % 100) / 10)
  const o = n % 10
  if (h) words.push(HUNDREDS[h])
  if (t === 1) {
    words.push(TEENS[o])
  } else {
    if (t) words.push(TENS[t])
    if (o) words.push((feminine ? ONES_F : ONES)[o])
  }
  return words.join(' ')
}

function plural(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return forms[0]
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1]
  return forms[2]
}

/** 6280.50 → "Шість тисяч двісті вісімдесят гривень 50 копійок" */
export function hryvniaToWords(hrn: number): string {
  const whole = Math.floor(hrn)
  const kop = Math.round((hrn - whole) * 100)
  if (whole === 0) return `Нуль гривень ${String(kop).padStart(2, '0')} коп.`

  const parts: string[] = []
  const millions = Math.floor(whole / 1_000_000)
  const thousands = Math.floor((whole % 1_000_000) / 1000)
  const rest = whole % 1000

  if (millions) parts.push(`${tripletToWords(millions, false)} ${plural(millions, ['мільйон', 'мільйони', 'мільйонів'])}`)
  if (thousands) parts.push(`${tripletToWords(thousands, true)} ${plural(thousands, ['тисяча', 'тисячі', 'тисяч'])}`)
  if (rest) parts.push(tripletToWords(rest, false))

  let text = parts.join(' ').trim()
  text = text.charAt(0).toUpperCase() + text.slice(1)
  const hrnWord = plural(whole, ['гривня', 'гривні', 'гривень'])
  return `${text} ${hrnWord} ${String(kop).padStart(2, '0')} коп.`
}

// ─────────────────────────────────────────────────────────────
// Текст для месенджера (підтвердження клієнту)
// ─────────────────────────────────────────────────────────────
export interface MessengerLine {
  name: string
  qty: number
  unitHrn: number // ціна за одиницю, грн
}
export interface MessengerInput {
  vin?: string | null
  car?: string | null // "HONDA CR-V I-CTDI"
  lines: MessengerLine[]
  fullyPaid: boolean
}

export function buildMessengerText(input: MessengerInput): string {
  const out: string[] = []
  if (input.vin) out.push(`VIN: ${input.vin}`)
  if (input.car) out.push(input.car)
  if (out.length) out.push('')

  let total = 0
  for (const line of input.lines) {
    const sum = line.unitHrn * line.qty
    total += sum
    // К-сть 1 → показуємо лише суму (без дублювання ціни): «Назва =300».
    // К-сть >1 → ціна за одиницю + кількість: «Назва 1100 x2 =2200».
    out.push(line.qty > 1
      ? `${line.name} ${moneyShort(line.unitHrn)} x${line.qty} =${moneyShort(sum)}`
      : `${line.name} =${moneyShort(sum)}`)
  }

  out.push('')
  out.push(`ИТОГ =${groupDot(total)}`)
  if (input.fullyPaid) {
    out.push('')
    out.push('Оплачено!')
  }
  return out.join('\n')
}

/** Готовий текст із збереженого замовлення. */
export function orderMessengerText(order: CustomerOrder): string {
  const v = order.vehicle_info
  const car = v ? [v.make, v.model].filter(Boolean).join(' ') : ''
  const paid = (order.total_paid ?? order.prepayment ?? 0) >= order.total_amount && order.total_amount > 0
  return buildMessengerText({
    vin: v?.vin ?? null,
    car: car || null,
    lines: order.items
      .filter((i) => !(i as { is_draft_note?: boolean }).is_draft_note)
      .map((i) => ({ name: i.name, qty: i.qty, unitHrn: i.sell_price / 100 })),
    fullyPaid: paid,
  })
}

// ─────────────────────────────────────────────────────────────
// Документи A4: рахунок-фактура і видаткова накладна
// ─────────────────────────────────────────────────────────────
const esc = PrintService.escapeHtml

function docNumber(order: CustomerOrder): string {
  return order.order_number != null ? String(order.order_number) : order.id.slice(0, 8)
}

function buyerName(order: CustomerOrder): string {
  const c = order.customer
  if (c?.full_name) return c.full_name
  if (c?.phone) return c.phone
  return 'Приватна особа'
}

function sellerBlock(s: SellerRequisites): string {
  const rows: string[] = []
  if (s.name) rows.push(`<div class="strong">${esc(s.name)}</div>`)
  if (s.edrpou) rows.push(`<div>Код ЄДРПОУ/ІПН: ${esc(s.edrpou)}</div>`)
  if (s.iban) rows.push(`<div>IBAN: ${esc(s.iban)}</div>`)
  if (s.bank) rows.push(`<div>Банк: ${esc(s.bank)}</div>`)
  if (s.address) rows.push(`<div>Адреса: ${esc(s.address)}</div>`)
  if (s.phone) rows.push(`<div>Тел.: ${esc(s.phone)}</div>`)
  if (!rows.length) rows.push('<div class="muted">Реквізити продавця не заповнені (Налаштування → Реквізити продавця)</div>')
  return rows.join('')
}

function itemsTable(order: CustomerOrder): { html: string; total: number } {
  let total = 0
  const rows = order.items
    .filter((i) => !(i as { is_draft_note?: boolean }).is_draft_note)
    .map((item, i) => {
      const unit = item.sell_price / 100
      const sum = unit * item.qty
      total += sum
      return `
        <tr>
          <td class="c">${i + 1}</td>
          <td>${esc(item.name)}${item.sku ? ` <span class="muted">(${esc(item.sku)})</span>` : ''}</td>
          <td class="c">${item.qty}</td>
          <td class="c">шт</td>
          <td class="r">${money(unit)}</td>
          <td class="r">${money(sum)}</td>
        </tr>`
    })
    .join('')
  return { html: rows, total }
}

function baseStyles(): string {
  return `
    @page { size: A4; margin: 14mm 12mm; }
    * { box-sizing: border-box; }
    body { font-family: 'Times New Roman', Georgia, serif; font-size: 12px; color: #000; margin: 0; }
    .doc { width: 100%; }
    h1 { font-size: 16px; margin: 0 0 2px; }
    .head { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
    .party { width: 48%; font-size: 11px; line-height: 1.35; }
    .party .cap { font-weight: bold; text-transform: uppercase; font-size: 10px; color: #444; margin-bottom: 2px; }
    .strong { font-weight: bold; }
    .muted { color: #666; }
    .title { text-align: center; margin: 12px 0; border-bottom: 2px solid #000; padding-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 11px; }
    th, td { border: 1px solid #000; padding: 4px 6px; vertical-align: top; }
    th { background: #f0f0f0; font-size: 10px; text-transform: uppercase; }
    td.c, th.c { text-align: center; }
    td.r, th.r { text-align: right; white-space: nowrap; }
    tfoot td { font-weight: bold; }
    .totalWords { margin-top: 8px; font-size: 11px; }
    .signs { display: flex; justify-content: space-between; margin-top: 34px; font-size: 11px; }
    .sign { width: 45%; }
    .sign .line { border-top: 1px solid #000; margin-top: 26px; padding-top: 3px; text-align: center; color: #444; font-size: 10px; }
    @media print { body { -webkit-print-color-adjust: exact; } }
  `
}

function printDoc(title: string, bodyHtml: string) {
  const html = `<html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${baseStyles()}</style></head><body>${bodyHtml}</body></html>`
  PrintService.printHtml(html, { mode: 'window', width: 800, height: 1000 })
}

/** Рахунок-фактура на оплату. */
export function printInvoice(order: CustomerOrder, seller: SellerRequisites) {
  const { html: rows, total } = itemsTable(order)
  const body = `
    <div class="doc">
      <div class="head">
        <div class="party">
          <div class="cap">Постачальник</div>
          ${sellerBlock(seller)}
        </div>
        <div class="party">
          <div class="cap">Покупець</div>
          <div class="strong">${esc(buyerName(order))}</div>
          ${order.customer?.phone ? `<div>Тел.: ${esc(order.customer.phone)}</div>` : ''}
        </div>
      </div>
      <div class="title">
        <h1>Рахунок-фактура № ${esc(docNumber(order))}</h1>
        <div>від ${formatDate(order.created_at)}</div>
      </div>
      <table>
        <thead>
          <tr><th class="c">№</th><th>Найменування</th><th class="c">К-сть</th><th class="c">Од.</th><th class="r">Ціна, грн</th><th class="r">Сума, грн</th></tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr><td colspan="5" class="r">Разом до сплати:</td><td class="r">${money(total)}</td></tr>
        </tfoot>
      </table>
      <div class="totalWords">Усього до сплати: <span class="strong">${esc(hryvniaToWords(total))}</span></div>
      <div class="signs">
        <div class="sign">Виписав(ла): <div class="line">${esc(seller.director || seller.name || '')}</div></div>
        <div class="sign">Отримав(ла): <div class="line">підпис покупця</div></div>
      </div>
    </div>`
  printDoc(`Рахунок-фактура №${docNumber(order)}`, body)
}

/** Видаткова накладна. */
export function printDeliveryNote(order: CustomerOrder, seller: SellerRequisites) {
  const { html: rows, total } = itemsTable(order)
  const itemCount = order.items.filter((i) => !(i as { is_draft_note?: boolean }).is_draft_note).length
  const body = `
    <div class="doc">
      <div class="head">
        <div class="party">
          <div class="cap">Постачальник</div>
          ${sellerBlock(seller)}
        </div>
        <div class="party">
          <div class="cap">Одержувач</div>
          <div class="strong">${esc(buyerName(order))}</div>
          ${order.customer?.phone ? `<div>Тел.: ${esc(order.customer.phone)}</div>` : ''}
        </div>
      </div>
      <div class="title">
        <h1>Видаткова накладна № ${esc(docNumber(order))}</h1>
        <div>від ${formatDate(order.created_at)}</div>
      </div>
      <table>
        <thead>
          <tr><th class="c">№</th><th>Найменування</th><th class="c">К-сть</th><th class="c">Од.</th><th class="r">Ціна, грн</th><th class="r">Сума, грн</th></tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr><td colspan="5" class="r">Разом:</td><td class="r">${money(total)}</td></tr>
        </tfoot>
      </table>
      <div class="totalWords">Усього найменувань ${itemCount}, на суму <span class="strong">${esc(hryvniaToWords(total))}</span></div>
      <div class="signs">
        <div class="sign">Відпустив(ла): <div class="line">${esc(seller.director || seller.name || '')}</div></div>
        <div class="sign">Отримав(ла): <div class="line">підпис одержувача</div></div>
      </div>
    </div>`
  printDoc(`Видаткова накладна №${docNumber(order)}`, body)
}
