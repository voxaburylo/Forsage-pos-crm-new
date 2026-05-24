import { logger } from '../../lib/logger.js'

/**
 * Mock-сервіс банківського термінала.
 * Імітує оплату карткою: 2 сек затримка → повертає код авторизації.
 */
export interface TerminalResult {
  success: boolean
  auth_code: string | null
  error?: string
}

export async function processCardPayment(
  amountKopecks: number,
  saleId?: string,
  saleNumber?: string,
): Promise<TerminalResult> {
  const ref = saleNumber ?? saleId ?? 'pre-auth'
  logger.info({ ref, amountKopecks }, 'Термінал: запит на оплату карткою...')

  // Імітація затримки 2 секунди
  await new Promise((resolve) => setTimeout(resolve, 2000))

  // У 3% випадків — помилка
  if (Math.random() < 0.03) {
    logger.warn({ ref }, 'Термінал: оплату відхилено')
    return { success: false, auth_code: null, error: 'Транзакцію відхилено. Спробуйте іншу картку.' }
  }

  const authCode = String(Math.floor(100000 + Math.random() * 900000))

  logger.info({ ref, authCode }, 'Термінал: оплату успішно завершено')
  return { success: true, auth_code: authCode }
}

export async function cancelCardPayment(
  authCode: string,
): Promise<boolean> {
  logger.info({ authCode }, 'Термінал (mock): скасування транзакції...')
  await new Promise((resolve) => setTimeout(resolve, 500))
  return true
}
