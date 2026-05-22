/**
 * ПриватБанк POS-термінал — інтеграція через локальний HTTP-агент
 *
 * ПриватБанк надає програму-агент яка встановлюється на ПК біля термінала
 * і слухає на локальному порту (за замовчуванням 8082).
 *
 * Налаштування в shop_settings:
 *   privatbank_terminal_ip   — IP агента (зазвичай 127.0.0.1 або IP в LAN)
 *   privatbank_terminal_port — порт агента (за замовчуванням 8082)
 *   privatbank_merchant_id   — MID (Merchant ID від ПриватБанку)
 *
 * Документація: зверніться до менеджера ПриватБанку за технічним описом
 * протоколу POS-інтеграції (файл "Опис протоколу POS-агента").
 */

import { logger } from '../../lib/logger.js'

export interface TerminalResult {
  success:    boolean
  auth_code:  string | null
  rrn:        string | null   // Reference Retrieval Number
  pan_masked: string | null   // Маскований номер картки (наприклад 4444****1111)
  error?:     string
}

interface TerminalConfig {
  ip:          string
  port:        number
  merchant_id: string
}

// ─── HTTP до локального агента ───────────────────────────────────────────────

async function agentRequest(
  config: TerminalConfig,
  path: string,
  body: Record<string, unknown>,
  timeoutMs = 120_000,  // 2 хвилини (клієнт може вводити PIN довго)
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(`http://${config.ip}:${config.port}${path}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`Термінал відповів ${res.status}: ${text}`)
    }

    return res.json()
  } finally {
    clearTimeout(timer)
  }
}

// ─── Оплата ──────────────────────────────────────────────────────────────────

/**
 * Ініціює оплату карткою на терміналі.
 * Агент ПриватБанку блокує відповідь поки клієнт не завершить операцію.
 */
export async function privatbankProcessPayment(
  config: TerminalConfig,
  amountKopecks: number,
  saleNumber: string,
): Promise<TerminalResult> {
  logger.info({ saleNumber, amountKopecks }, 'Термінал ПриватБанк: запит оплати...')

  try {
    const data = await agentRequest(config, '/transaction/purchase', {
      amount:      amountKopecks,        // копійки
      currency:    980,                   // UAH
      order_id:    saleNumber,
      merchant_id: config.merchant_id,
    }) as any

    // Агент повертає: { result_code, auth_code, rrn, pan_masked, message }
    const approved = data.result_code === '000' || data.result_code === '00' || data.success === true

    if (!approved) {
      const msg = data.message || data.error_message || `Код відмови: ${data.result_code}`
      logger.warn({ saleNumber, result_code: data.result_code }, 'Термінал: транзакцію відхилено')
      return { success: false, auth_code: null, rrn: null, pan_masked: null, error: msg }
    }

    logger.info({ saleNumber, auth_code: data.auth_code, rrn: data.rrn }, 'Термінал: оплату підтверджено')
    return {
      success:    true,
      auth_code:  data.auth_code  ?? null,
      rrn:        data.rrn        ?? null,
      pan_masked: data.pan_masked ?? data.pan ?? null,
    }
  } catch (err: any) {
    const isTimeout = err.name === 'AbortError'
    const msg = isTimeout
      ? 'Термінал не відповів за 2 хвилини (клієнт не завершив операцію або збій зв\'язку)'
      : `Помилка зв\'язку з терміналом: ${err.message}`

    logger.error({ saleNumber, error: err.message }, 'Термінал: помилка зв\'язку')
    return { success: false, auth_code: null, rrn: null, pan_masked: null, error: msg }
  }
}

// ─── Повернення ──────────────────────────────────────────────────────────────

export async function privatbankProcessRefund(
  config: TerminalConfig,
  amountKopecks: number,
  originalRrn: string,
  saleNumber: string,
): Promise<TerminalResult> {
  logger.info({ saleNumber, originalRrn }, 'Термінал ПриватБанк: повернення...')

  try {
    const data = await agentRequest(config, '/transaction/refund', {
      amount:      amountKopecks,
      currency:    980,
      order_id:    saleNumber,
      rrn:         originalRrn,
      merchant_id: config.merchant_id,
    }) as any

    const approved = data.result_code === '000' || data.result_code === '00' || data.success === true
    if (!approved) {
      return { success: false, auth_code: null, rrn: null, pan_masked: null, error: data.message ?? 'Відмова' }
    }

    return { success: true, auth_code: data.auth_code ?? null, rrn: data.rrn ?? null, pan_masked: null }
  } catch (err: any) {
    return { success: false, auth_code: null, rrn: null, pan_masked: null, error: err.message }
  }
}

// ─── Скасування ──────────────────────────────────────────────────────────────

export async function privatbankCancelPayment(
  config: TerminalConfig,
  originalRrn: string,
): Promise<boolean> {
  try {
    const data = await agentRequest(config, '/transaction/cancel', {
      rrn:         originalRrn,
      merchant_id: config.merchant_id,
    }, 30_000) as any

    return data.result_code === '000' || data.success === true
  } catch {
    return false
  }
}
