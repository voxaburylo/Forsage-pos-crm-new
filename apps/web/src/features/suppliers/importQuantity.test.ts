import {expect,it} from 'vitest'
import {parseImportQuantity} from './importApi'
it('keeps fractional units and rejects missing/corrupt amounts',()=>{expect(parseImportQuantity('0,125')).toBe(.125);expect(parseImportQuantity('12')).toBe(12);expect(parseImportQuantity('0')).toBe(0);for(const value of ['','unknown','12x','1,2,3'])expect(parseImportQuantity(value)).toBeNaN()})
