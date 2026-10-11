import { describe, expect, it } from 'vitest'
import { cashalotReceiptNumber, requireCashalotReceipt } from '../src/fiscal/cashalotReceipt'

describe('Cashalot receipt number selection', () => {
  it.each([
    ['fiscal first', { ReceiptFiscalNum: '  F-001  ', ReceiptLocalNum: '  L-002  ' }, 'F-001'],
    ['local only', { ReceiptLocalNum: '  L-002  ' }, 'L-002'],
    ['blank fiscal', { ReceiptFiscalNum: '', ReceiptLocalNum: ' L-002 ' }, 'L-002'],
    ['whitespace fiscal', { ReceiptFiscalNum: ' \t\n ', ReceiptLocalNum: ' L-002 ' }, 'L-002'],
    ['null fiscal', { ReceiptFiscalNum: null, ReceiptLocalNum: ' L-002 ' }, 'L-002'],
    ['undefined fiscal', { ReceiptFiscalNum: undefined, ReceiptLocalNum: ' L-002 ' }, 'L-002'],
    ['numeric fiscal ignored', { ReceiptFiscalNum: 123, ReceiptLocalNum: ' L-002 ' }, 'L-002'],
    ['object fiscal ignored', { ReceiptFiscalNum: {}, ReceiptLocalNum: ' L-002 ' }, 'L-002'],
    ['non-string local ignored', { ReceiptFiscalNum: ' F-001 ', ReceiptLocalNum: true }, 'F-001'],
    ['blank numbers', { ReceiptFiscalNum: ' ', ReceiptLocalNum: '\t' }, null],
    ['numeric numbers', { ReceiptFiscalNum: 123, ReceiptLocalNum: 456 }, null],
    ['booleans', { ReceiptFiscalNum: true, ReceiptLocalNum: false }, null],
    ['object and array fields', { ReceiptFiscalNum: {}, ReceiptLocalNum: ['L-002'] }, null],
    ['missing numbers', {}, null],
    ['null result', null, null],
    ['undefined result', undefined, null],
    ['string result', 'F-001', null],
    ['numeric result', 123, null],
    ['boolean result', true, null],
    ['array result', [], null],
  ] as const)('selects the first usable string without coercion: %s', (_label, result, expected) => {
    expect(cashalotReceiptNumber(result)).toBe(expected)
  })

  it('can read a historical numbered result without requiring a Return field', () => {
    expect(cashalotReceiptNumber({ ReceiptFiscalNum: ' LEGACY-001 ' })).toBe('LEGACY-001')
    expect(cashalotReceiptNumber({ ReceiptLocalNum: ' LEGACY-LOCAL-001 ' })).toBe('LEGACY-LOCAL-001')
  })
})

describe('Cashalot fiscal receipt confirmation', () => {
  const unconfirmed = /^FISCAL_RECEIPT_UNCONFIRMED\|/

  it.each([
    ['missing result', undefined],
    ['null result', null],
    ['empty object', {}],
    ['array', []],
    ['string', 'receipt'],
    ['boolean', true],
    ['number', 123],
    ['primitive wrapper', { Value: true }],
    ['primitive rejection wrapper', { Value: false }],
    ['missing Return', { ReceiptFiscalNum: 'F-001' }],
    ['null Return', { Return: null, ReceiptFiscalNum: 'F-001' }],
    ['false Return', { Return: false, ReceiptFiscalNum: 'F-001', Description: 'Rejected' }],
    ['string true Return', { Return: 'true', ReceiptFiscalNum: 'F-001' }],
    ['string false Return', { Return: 'false', ReceiptFiscalNum: 'F-001' }],
    ['numeric Return', { Return: 1, ReceiptFiscalNum: 'F-001' }],
    ['array Return', { Return: [true], ReceiptFiscalNum: 'F-001' }],
    ['object Return', { Return: {}, ReceiptFiscalNum: 'F-001' }],
    ['success without numbers', { Return: true }],
    ['success with null numbers', { Return: true, ReceiptFiscalNum: null, ReceiptLocalNum: null }],
    ['success with empty numbers', { Return: true, ReceiptFiscalNum: '', ReceiptLocalNum: '' }],
    ['success with whitespace numbers', { Return: true, ReceiptFiscalNum: ' \n ', ReceiptLocalNum: '\t' }],
  ] as const)('rejects unconfirmed result: %s', (_label, result) => {
    expect(() => requireCashalotReceipt(result)).toThrow(unconfirmed)
  })

  it.each([0, 123, true, false, [], {}, ['F-001']].map(invalid => ({ invalid })))(
    'rejects a non-string number field even when the other number is valid: %j', ({ invalid }) => {
      expect(() => requireCashalotReceipt({ Return: true, ReceiptFiscalNum: invalid,
        ReceiptLocalNum: 'L-002' })).toThrow(unconfirmed)
      expect(() => requireCashalotReceipt({ Return: true, ReceiptFiscalNum: 'F-001',
        ReceiptLocalNum: invalid })).toThrow(unconfirmed)
    },
  )

  it('rejects an array even if properties mimic a successful receipt', () => {
    const result = Object.assign([], { Return: true, ReceiptFiscalNum: 'F-001' })
    expect(() => requireCashalotReceipt(result)).toThrow(unconfirmed)
  })

  it.each(['0', '00000123', 'LOCAL/0004.25', 'ОФЛАЙН-№001:А/7'])(
    'accepts nonempty identifiers without inventing a numeric format: %s', number => {
      for (const field of ['ReceiptFiscalNum', 'ReceiptLocalNum'] as const) {
        const result = requireCashalotReceipt({ Return: true, [field]: `  ${number}  ` })
        expect(result[field]).toBe(number)
        expect(cashalotReceiptNumber(result)).toBe(number)
      }
    },
  )

  it('accepts a local-only receipt without demanding OfflineMode or a fiscal number', () => {
    expect(requireCashalotReceipt({ Return: true, ReceiptLocalNum: ' LOCAL-001 ' }))
      .toEqual({ Return: true, ReceiptLocalNum: 'LOCAL-001' })
  })

  it('uses a valid local number when the fiscal field is blank and retains offline metadata', () => {
    const result = requireCashalotReceipt({ Return: true, ReceiptFiscalNum: ' \t ',
      ReceiptLocalNum: ' LOCAL-001 ', OfflineMode: true, ShiftID: 'SHIFT-1' })
    expect(result).toEqual({ Return: true, ReceiptFiscalNum: '',
      ReceiptLocalNum: 'LOCAL-001', OfflineMode: true, ShiftID: 'SHIFT-1' })
    expect(cashalotReceiptNumber(result)).toBe('LOCAL-001')
  })

  it('trims only number strings, preserves metadata, and does not mutate the input', () => {
    const metadata = Object.freeze({ arbitrary: 'preserved' })
    const input = Object.freeze({ Return: true, ReceiptFiscalNum: ' F-001 ',
      ReceiptLocalNum: ' L-002 ', Description: '  original description  ',
      JsonVal: '{"original":true}', FSKOReceiptLink: ' https://example.invalid/receipt ',
      CashalotReceiptLink: null, OfflineMode: false, ShiftID: ' SHIFT-1 ',
      Type: 1, Value: metadata })
    expect(requireCashalotReceipt(input)).toEqual({ ...input,
      ReceiptFiscalNum: 'F-001', ReceiptLocalNum: 'L-002' })
    expect(input.ReceiptFiscalNum).toBe(' F-001 ')
    expect(input.ReceiptLocalNum).toBe(' L-002 ')
    expect(metadata).toEqual({ arbitrary: 'preserved' })
  })

  it('preserves absent, explicitly undefined and null number fields', () => {
    const absent = requireCashalotReceipt({ Return: true, ReceiptFiscalNum: ' F-001 ' })
    expect(Object.hasOwn(absent, 'ReceiptLocalNum')).toBe(false)
    const missing = requireCashalotReceipt({ Return: true, ReceiptFiscalNum: undefined,
      ReceiptLocalNum: ' L-002 ' })
    expect(Object.hasOwn(missing, 'ReceiptFiscalNum')).toBe(true)
    expect(missing.ReceiptFiscalNum).toBeUndefined()
    const nullable = requireCashalotReceipt({ Return: true, ReceiptFiscalNum: ' F-001 ',
      ReceiptLocalNum: null })
    expect(Object.hasOwn(nullable, 'ReceiptLocalNum')).toBe(true)
    expect(nullable.ReceiptLocalNum).toBeNull()
  })
})
