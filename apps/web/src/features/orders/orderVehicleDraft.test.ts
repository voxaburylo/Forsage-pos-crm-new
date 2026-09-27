import { describe, expect, it } from 'vitest'
import { orderVehicleFromDraft } from './orderVehicleDraft'
describe('order vehicle draft', () => {
  it('uses edited fields and normalizes VIN without guessing missing details', () => {
    expect(orderVehicleFromDraft({ brand: ' MAN ', model: ' Corrected ', vin: ' abc123 ', year: ' 2005 ' })).toEqual({ make: 'MAN', model: 'Corrected', vin: 'ABC123', year: 2005 })
  })
  it('allows VIN-only and blank drafts', () => {
    expect(orderVehicleFromDraft({ brand: '', model: '', vin: 'ABC', year: '' })).toEqual({ vin: 'ABC', make: undefined, model: undefined, year: undefined })
    expect(orderVehicleFromDraft({ brand: ' ', model: '', vin: '', year: '' })).toBeNull()
  })
  it.each(['20', '2005abc', '2e3', 'NaN', '2020.5', '1800', '2101'])('rejects a malformed year: %s', year => {
    expect(() => orderVehicleFromDraft({ brand: '', model: '', vin: '', year })).toThrow('рік')
  })
})
