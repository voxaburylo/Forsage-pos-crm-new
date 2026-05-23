import { logger } from '../../lib/logger.js'

/**
 * Mock SMS notification channel.
 * Logs SMS details to the console/logger.
 */
export async function sendSms(phone: string, text: string): Promise<boolean> {
  logger.info({ phone, text }, '📱 [MOCK SMS] Sending SMS notification...')
  return true
}
