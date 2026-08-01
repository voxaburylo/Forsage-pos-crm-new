import { describe, expect, it } from 'vitest'
import { pickLabelPrinter } from './tsplPrintSettings'
import { pickReceiptPrinter } from '../pos/receiptPrinterSettings'

describe('thermal printer routing', () => {
  const printers = [
    { name: 'XPrinter POS-58', isDefault: true },
    { name: 'XPrinter XP-80C' },
    { name: 'HiLabel HL-80' },
  ]

  it('routes 58 mm devices only to receipt printing', () => {
    expect(pickReceiptPrinter(printers)).toBe('XPrinter POS-58')
    expect(pickLabelPrinter(printers)).not.toBe('XPrinter POS-58')
  })

  it('recognizes both an XP-80 and an HL-80 as label printers', () => {
    expect(pickLabelPrinter(printers)).toBe('XPrinter XP-80C')
    expect(pickReceiptPrinter([{ name: 'HiLabel HL-80', isDefault: true }])).toBeNull()
  })

  it('never substitutes a default printer with the wrong physical role', () => {
    expect(pickReceiptPrinter([{ name: 'Office Laser', isDefault: true }])).toBeNull()
    expect(pickReceiptPrinter([{ name: 'XPrinter POS-80', isDefault: true }])).toBeNull()
    expect(pickLabelPrinter([{ name: 'XPrinter POS-58' }])).toBeNull()
  })
})
