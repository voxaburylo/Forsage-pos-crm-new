import type { LocalDatabase } from '../db/localDatabase'
import { LocalPosReports } from './pos/reports'

/**
 * Каса як єдине ціле. Сам клас порожній: уся робота живе в шарах під ним —
 * див. `pos/`. Так зроблено, щоб файл на 3431 рядок став читабельним, не
 * змінивши жодного рядка поведінки.
 */
export class LocalPosRepository extends LocalPosReports {
  constructor(db: LocalDatabase) {
    super(db)
    this.markInterruptedFiscalIntentsUnknown()
  }
}
