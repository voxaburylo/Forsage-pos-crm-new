import { describe, expect, it } from 'vitest'
import { localizeDesktopIpcError } from '../src/ipcError'

describe('localizeDesktopIpcError', () => {
  it('removes Electron IPC implementation details', () => {
    expect(localizeDesktopIpcError(
      new Error("Error invoking remote method 'desktop:catalog:save-product': Error: Вкажіть назву"),
    ).message).toBe('Вкажіть назву')
  })

  it('translates common SQLite errors', () => {
    expect(localizeDesktopIpcError(new Error('Error: FOREIGN KEY constraint failed')).message)
      .toContain('пов’язаний запис не знайдено')
    expect(localizeDesktopIpcError(new Error('UNIQUE constraint failed: products.sku')).message)
      .toContain('Такий запис уже існує')
    expect(localizeDesktopIpcError(new Error('SQLITE_BUSY: database is locked')).message)
      .toContain('Локальна база зараз зайнята')
  })

  it('explains that an unsafe barcode must be widened in the designer', () => {
    expect(localizeDesktopIpcError(new Error('TSPL_BARCODE_TOO_NARROW')).message)
      .toContain('Збільште його ширину в дизайнері етикетки')
  })
  it('localizes barcode DOM and canvas preparation failures', () => {
    expect(localizeDesktopIpcError(new Error('TSPL_BARCODE_IMAGE_NOT_FOUND')).message)
      .toContain('Збережіть дизайн і повторіть друк')
    expect(localizeDesktopIpcError(new Error('TSPL_BARCODE_CANVAS_UNAVAILABLE')).message)
      .toContain('Перезапустіть програму та повторіть')
  })
  it('preserves the fiscal recovery protocol marker', () => {
    const marker = 'FISCAL_INTENT_UNKNOWN|op-1|Не повторюйте оплату'
    expect(localizeDesktopIpcError(
      new Error("Error invoking remote method 'desktop:fiscal:fiscalize-sale': Error: " + marker),
    ).message).toBe(marker)
  })

  it('shows only the Ukrainian text for a pending fiscal return', () => {
    const visible = 'Для цього чека вже є незавершене фіскальне повернення'
    expect(localizeDesktopIpcError(
      new Error(
        "Error invoking remote method 'desktop:pos:create-return': Error: FISCAL_RETURN_PENDING|" + visible,
      ),
    ).message).toBe(visible)
  })
})
