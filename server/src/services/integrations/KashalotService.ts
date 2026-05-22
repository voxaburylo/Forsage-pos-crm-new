/**
 * Кашалот ПРРО — інтеграція через REST API
 * Документація: https://doc.kashalot.ua/api/
 *
 * Потребує в shop_settings:
 *   kashalot_license_key  — ключ ліцензії (видається при реєстрації)
 *   kashalot_pin          — PIN-код касира
 *   kashalot_cashier_id   — ID касира (отримується після авторизації)
 *   kashalot_active_shift — ID поточної зміни Кашалот
 */

import { logger } from '../../lib/logger.js'

const BASE_URL = 'https://api.kashalot.ua'

export interface KashalotReceipt {
  success: boolean
  fiscal_number: string | null
  qr_url: string | null
  receipt_url: string | null
  error?: string
}

interface KashalotSettings {
  license_key: string
  pin: string
  cashier_id?: string
  active_shift_id?: string
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function request<T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`Kashalot ${method} ${path} → ${res.status}: ${text}`)
  }

  return res.json() as Promise<T>
}

// ─── Авторизація ─────────────────────────────────────────────────────────────

/**
 * Вхід касира → повертає JWT-токен.
 * Кашалот приймає: license_key + pin
 */
export async function kashalotLogin(settings: KashalotSettings): Promise<string> {
  logger.info('Kashalot: авторизація касира...')

  const data = await request<{ access_token: string }>('POST', '/api/v1/cashiers/signin', '', {
    login:    settings.license_key,
    password: settings.pin,
  })

  logger.info('Kashalot: авторизація успішна')
  return data.access_token
}

// ─── Зміна ───────────────────────────────────────────────────────────────────

export async function kashalotOpenShift(token: string): Promise<string> {
  logger.info('Kashalot: відкриття зміни...')

  const data = await request<{ id: string }>('POST', '/api/v1/shifts', token)
  logger.info({ shift_id: data.id }, 'Kashalot: зміну відкрито')
  return data.id
}

export async function kashalotCloseShift(token: string, shiftId: string): Promise<void> {
  logger.info({ shift_id: shiftId }, 'Kashalot: закриття зміни...')
  await request('POST', `/api/v1/shifts/${shiftId}/close`, token)
  logger.info('Kashalot: зміну закрито')
}

export async function kashalotGetCurrentShift(token: string): Promise<string | null> {
  try {
    const data = await request<{ id: string; status: string } | null>('GET', '/api/v1/shifts', token)
    if (data && data.status === 'OPENED') return data.id
    return null
  } catch {
    return null
  }
}

// ─── Фіскалізація чека ───────────────────────────────────────────────────────

interface SaleItem {
  name: string
  qty: number
  unit_price: number  // копійки
  discount: number    // копійки
}

/**
 * Фіскалізує продаж і повертає номер + QR-посилання.
 *
 * Структура чека Кашалот:
 * {
 *   payment: { type: 'CASHLESS' | 'CASH', value: <kopecks> },
 *   goods: [{ code, name, price, quantity, unit, letters }],
 * }
 */
export async function kashalotFiscalize(
  token: string,
  shiftId: string,
  saleNumber: string,
  totalKopecks: number,
  items: SaleItem[],
  paymentMethod: 'cash' | 'card' | 'mixed' | 'transfer' | 'debt',
): Promise<KashalotReceipt> {
  logger.info({ saleNumber, totalKopecks }, 'Kashalot: фіскалізація...')

  const paymentType = paymentMethod === 'cash' ? 'CASH' : 'CASHLESS'

  const payload = {
    shift_id: shiftId,
    goods: items.map((item, idx) => ({
      code:     idx + 1,
      name:     item.name.slice(0, 128),
      price:    item.unit_price,     // копійки
      quantity: item.qty * 1000,     // Кашалот: кількість × 1000
      unit:     'шт',
      letters:  'ABCDEF'[idx % 6] ?? 'A',
      discounts: item.discount > 0
        ? [{ type: 'DISCOUNT', value: item.discount }]
        : [],
    })),
    payments: [{ type: paymentType, value: totalKopecks }],
    receipt_no: saleNumber,
  }

  try {
    const data = await request<{
      id: string
      fiscal_code: string
      qr_url?: string
      html_url?: string
    }>('POST', `/api/v1/receipts/sell`, token, payload)

    logger.info({ fiscal_code: data.fiscal_code }, 'Kashalot: чек зафіскалізовано')

    return {
      success:      true,
      fiscal_number: data.fiscal_code,
      qr_url:       data.qr_url ?? null,
      receipt_url:  data.html_url ?? null,
    }
  } catch (err: any) {
    logger.error({ error: err.message }, 'Kashalot: помилка фіскалізації')
    return {
      success:      false,
      fiscal_number: null,
      qr_url:       null,
      receipt_url:  null,
      error:        err.message,
    }
  }
}

// ─── Повернення ──────────────────────────────────────────────────────────────

export async function kashalotFiscalizeReturn(
  token: string,
  shiftId: string,
  originalFiscalNumber: string,
  totalKopecks: number,
  items: SaleItem[],
): Promise<KashalotReceipt> {
  logger.info({ originalFiscalNumber }, 'Kashalot: фіскалізація повернення...')

  const payload = {
    shift_id:         shiftId,
    reference_code:   originalFiscalNumber,
    goods: items.map((item, idx) => ({
      code:     idx + 1,
      name:     item.name.slice(0, 128),
      price:    item.unit_price,
      quantity: item.qty * 1000,
      unit:     'шт',
      letters:  'A',
    })),
    payments: [{ type: 'CASH', value: totalKopecks }],
  }

  try {
    const data = await request<{ id: string; fiscal_code: string; qr_url?: string }>(
      'POST', `/api/v1/receipts/return`, token, payload,
    )

    return {
      success:      true,
      fiscal_number: data.fiscal_code,
      qr_url:       data.qr_url ?? null,
      receipt_url:  null,
    }
  } catch (err: any) {
    logger.error({ error: err.message }, 'Kashalot: помилка фіскалізації повернення')
    return { success: false, fiscal_number: null, qr_url: null, receipt_url: null, error: err.message }
  }
}
