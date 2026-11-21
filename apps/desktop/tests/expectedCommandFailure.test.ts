import { describe, expect, it } from 'vitest'
import { isExpectedCommandFailure } from '../src/diagnostics/expectedCommandFailure'

describe('problem journal keeps only real faults (20.11.2026)', () => {
  it('ordinary refusals shown to the cashier are not logged', () => {
    for (const message of [
      'Недостатньо товару «Хомут». Доступно: 0, потрібно: 1',
      'Недостатньо залишку для «Фільтр»: доступно 0, потрібно 2',
      'INSUFFICIENT_STOCK',
      'Товар не знайдено',
      'Невірний PIN-код',
      'Невірний поточний PIN',
      'Видалити можна лише неоплачену чернетку накладної.',
      'Кількість у накладній має бути більше нуля',
      'Цей штрихкод уже належить іншому клієнту',
      'Зарплата стане доступною 2026-09-27',
    ]) expect(isExpectedCommandFailure(message), message).toBe(true)
  })
  it('real faults and receiving line reasons are still logged', () => {
    for (const message of [
      'SQLITE_BUSY: database is locked',
      'Error while decrypting the ciphertext provided to safeStorage.decryptString.',
      'FOREIGN KEY constraint failed',
      'RECEIVING_LINE:3:Недостатньо товару',
    ]) expect(isExpectedCommandFailure(message), message).toBe(false)
  })
})
