import { logger } from '../../lib/logger.js'

/**
 * Mock-сервіс ПРРО (програмний реєстратор розрахункових операцій).
 * Імітує фіскалізацію чеку: 2 сек затримка → повертає фейковий фіскальний номер.
 */
export interface FiscalResult {
  success: boolean
  fiscal_number: string | null
  error?: string
}

export async function fiscalizeSale(
  saleId: string,
  saleNumber: string,
  totalKopecks: number,
): Promise<FiscalResult> {
  logger.info({ saleId, saleNumber, totalKopecks }, 'ПРРО: фіскалізація чеку...')

  // Імітація затримки 2 секунди
  await new Promise((resolve) => setTimeout(resolve, 2000))

  // У 5% випадків імітуємо помилку
  if (Math.random() < 0.05) {
    logger.warn({ saleId }, 'ПРРО: помилка фіскалізації (таймаут)')
    return { success: false, fiscal_number: null, error: 'Помилка зв\'язку з ПРРО. Спробуйте ще раз.' }
  }

  const fiscalNumber = `FIS-${Date.now().toString(36).toUpperCase()}-${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`

  logger.info({ saleId, fiscalNumber }, 'ПРРО: чек успішно зафіскалізовано')
  return { success: true, fiscal_number: fiscalNumber }
}
