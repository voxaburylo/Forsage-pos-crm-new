import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parseSupplyText, parseSupplyWorkbook } from './aiSupplyImport'
const header=['Назва','Кількість','Ціна','Сума']
const item=['Фільтр',2,100,200]
const text=(rows:unknown[][])=>rows.map(row=>row.join('\t')).join('\n')
function book(sheets:unknown[][][]) {
  const wb=XLSX.utils.book_new()
  sheets.forEach((rows,i)=>XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),'Аркуш '+(i+1)))
  return XLSX.write(wb,{type:'array',bookType:'xlsx'}) as ArrayBuffer
}
describe('Local table and clipboard document totals',()=>{
  it.each(['Разом','Всього','Усього','Итого','Всего','Total','Grand total','Разом за накладною'])('checks the final %s instead of dropping it',label=>{
    expect(parseSupplyText(text([header,item,[label,'','',200]])).products).toHaveLength(1)
    expect(()=>parseSupplyText(text([header,item,[label,'','',250]]))).toThrow('підсум')
  })
  it.each(['Загальна сума','Общая сумма','Grand total','Invoice total','Amount due','Page total','Carried forward','Subtotal'])('checks money directly after %s without a colon',label=>{
    expect(parseSupplyText(text([header,item,[label+' 200 грн']])).products).toHaveLength(1)
    expect(()=>parseSupplyText(text([header,item,[label+' 250 грн']]))).toThrow(/підсум|перенес/)
  })
  it('does not lose a total outside the table header width',()=>{
    expect(()=>parseSupplyText(text([header,item,['Разом','','','','',250]]))).toThrow('підсум')
    expect(parseSupplyText(text([header,item,['Разом','','','','',200]])).products).toHaveLength(1)
  })
  it('reads a final amount in the price column of a three-column table',()=>{
    const rows=[header.slice(0,3),item.slice(0,3),['Разом','',200]]
    expect(parseSupplyText(text(rows)).products).toHaveLength(1)
    expect(()=>parseSupplyText(text([...rows.slice(0,2),['Разом','',201]]))).toThrow('підсум')
  })
  it('checks amount and number of positions embedded in a TDSheet sentence',()=>{
    expect(parseSupplyText(text([header,item,['Всього найменувань 1, на суму 200,00 USD.']])).sourceCurrency).toBe('USD')
    expect(()=>parseSupplyText(text([header,item,['Всього найменувань 2, на суму 200,00 USD.']]))).toThrow('позиці')
    expect(()=>parseSupplyText(text([header,item,['Всього найменувань 1, на суму 250,00 USD.']]))).toThrow('підсум')
  })
  it('checks separate page totals and never stops reading at them',()=>{
    const rows=[header,item,['Разом за сторінку','','',200],header,['Ключ',1,150,150],['Разом за сторінку','','',150],['Разом за накладною','','',350]]
    expect(parseSupplyText(text(rows)).products).toHaveLength(2)
    rows[5][3]=151
    expect(()=>parseSupplyText(text(rows))).toThrow('підсум')
  })
  it('does not guess the meaning of a final generic total after intermediate totals',()=>{
    expect(()=>parseSupplyText(text([header,item,['Разом','','',200],['Ключ',1,150,150],['Разом','','',350]]))).toThrow('Уточніть')
  })
  it('preserves later goods after an intermediate summary and repeated summary sentence',()=>{
    expect(parseSupplyText(text([header,item,['Разом','','',200],['Всього найменувань 1, на суму 200 грн.'],item])).products).toHaveLength(2)
  })
  it('does not import footer arithmetic as a product or decide between conflicting totals',()=>{
    expect(()=>parseSupplyText(text([header,item,['Разом','','',200],['Разом','','',250]]))).toThrow('підсум')
    expect(()=>parseSupplyText(text([header,item,['Разом','',200,250]]))).toThrow()
  })
  it('keeps zero totals and exact rounded line cents',()=>{
    expect(parseSupplyText(text([header,['Дарунок',1,0,0],['Разом','','',0]])).products).toHaveLength(1)
    const rows=[header,['А',1.5,1.01,1.52],['Б',1.5,1.01,1.52],['Разом','','',3.04]]
    expect(parseSupplyText(text(rows)).products).toHaveLength(2)
    rows[3][3]=3.03
    expect(()=>parseSupplyText(text(rows))).toThrow('підсум')
  })
  it('compares final inclusive VAT with final line prices without adding VAT a second time',()=>{
    expect(parseSupplyText(text([header,item,['Разом з ПДВ','','',200]])).products).toHaveLength(1)
    expect(()=>parseSupplyText(text([header,item,['Разом з ПДВ','','',240]]))).toThrow('підсум')
  })
  it.each(['невідомо','#VALUE!','2 00','-200','2e2'])('rejects malformed stated total %s',total=>{
    expect(()=>parseSupplyText(text([header,item,['Разом','','',total]]))).toThrow()
  })
  it('does not mistake product names or identifiers for totals',()=>{
    const rows=[['Назва','Артикул','Кількість','Ціна','Сума'],['Total Quartz','0001',2,100,200],['Разом набір','SET-1',1,50,50],['Разом','','','',250]]
    expect(parseSupplyText(text(rows)).products.map(row=>row.sku)).toEqual(['0001','SET-1'])
  })
  it('verifies sheet subtotals and the explicit whole-workbook total once',()=>{
    const sheets=[[header,item,['Разом','','',200]],[header,['Ключ',1,150,150],['Разом','','',150],['Разом за накладною','','',350]]]
    expect(parseSupplyWorkbook(book(sheets)).products).toHaveLength(2)
    sheets[1][3][3]=300
    expect(()=>parseSupplyWorkbook(book(sheets))).toThrow('підсум')
  })
  it('does not accept a correct first sheet when the second sheet has a wrong subtotal',()=>{
    expect(()=>parseSupplyWorkbook(book([[header,item,['Разом','','',200]],[header,['Ключ',1,150,150],['Разом','','',200]]]))).toThrow('підсум')
  })
  it('reads a dedicated final-total sheet without losing it or creating a product',()=>{
    expect(parseSupplyWorkbook(book([[header,item],[header,['Ключ',1,150,150]],[['Разом за накладною: 350 грн']]])).products).toHaveLength(2)
    expect(()=>parseSupplyWorkbook(book([[header,item],[['Разом за накладною: 300 грн']]]))).toThrow('підсум')
  })
  it('compares carried totals cumulatively across sheets, not as new goods',()=>{
    const sheets=[[header,item,['Перенос на наступну сторінку','','',200]],[header,['Перенос з попередньої сторінки','','',200],['Ключ',1,150,150],['Разом за накладною','','',350]]]
    expect(parseSupplyWorkbook(book(sheets)).products).toHaveLength(2)
    sheets[1][1][3]=190
    expect(()=>parseSupplyWorkbook(book(sheets))).toThrow('перенес')
  })
  it('keeps an unknown sheet for full review, without returning earlier rows as complete',()=>{
    const parsed=parseSupplyWorkbook(book([[header,item,['Разом','','',200]],[['Ще один аркуш без колонок'],['Гайка 50грн']]]))
    expect(parsed.products).toEqual([])
    expect(parsed.text).toContain('Гайка')
  })
  it.each(['Total Quartz 9000','Total 5W30'])('does not classify %s without SKU as a financial footer',name=>{
    expect(parseSupplyText(text([header,[name,2,100,200],['Разом','','',200]])).products[0].name).toBe(name)
  })
  it.each(['В т.ч. ПДВ 20%','В т. ч. НДС 20%'])('preserves an included tax note %s without a partial import',label=>{
    expect(parseSupplyText(text([header,item,[label,'','',33.33],['Разом','','',200]])).products).toHaveLength(1)
  })
  it.each(['-1','1.5','1,5','невідомо'])('rejects invalid stated position count %s',count=>{
    expect(()=>parseSupplyText(text([header,item,['Всього найменувань '+count+', на суму 200 грн']]))).toThrow('позиці')
  })
  it('checks an explicit document total before the table header',()=>{
    expect(()=>parseSupplyText(text([['Разом за накладною: 300 грн'],header,item]))).toThrow('підсум')
  })
  it('checks the Russian position-count footer without splitting its decimal amount',()=>{
    expect(parseSupplyText(text([header,item,['Всего наименований 1, на сумму 200,00 USD.']])).products).toHaveLength(1)
    expect(()=>parseSupplyText(text([header,item,['Всего наименований 2, на сумму 200,00 USD.']]))).toThrow('позиці')
  })
  it('checks brought-forward money before a repeated header on the next sheet',()=>{
    const sheets=[[header,item],[['Перенос з попередньої сторінки','','',200],header,['Ключ',1,150,150],['Разом за накладною','','',350]]]
    expect(parseSupplyWorkbook(book(sheets)).products).toHaveLength(2)
    sheets[1][0][3]=190
    expect(()=>parseSupplyWorkbook(book(sheets))).toThrow('перенес')
  })
  it('checks a standalone position count without treating it as money',()=>{
    expect(parseSupplyText(text([header,item,['Всього позицій: 1']])).products).toHaveLength(1)
    expect(()=>parseSupplyText(text([header,item,['Всього позицій: 2']]))).toThrow('позиці')
  })
  it('refuses Excel error cells that sheet conversion would otherwise turn into blanks',()=>{
    const wb=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([header,item,['Разом']])
    sheet.D3={t:'e',v:15};sheet['!ref']='A1:D3'
    XLSX.utils.book_append_sheet(wb,sheet,'Помилка')
    expect(()=>parseSupplyWorkbook(XLSX.write(wb,{type:'array',bookType:'xlsx'}))).toThrow('D3')
  })
  it('keeps empty 1C-style cells distinct from actual Excel errors',()=>{
    const wb=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([header,item,['Разом','','',200]])
    sheet.E1={t:'e'};sheet.E2={t:'e'};sheet['!ref']='A1:E3'
    XLSX.utils.book_append_sheet(wb,sheet,'Порожні')
    expect(parseSupplyWorkbook(XLSX.write(wb,{type:'array',bookType:'xlsx'})).products).toHaveLength(1)
  })
  it('verifies a correct cached formula total without recalculating or changing it',()=>{
    const wb=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([header,item,['Разом']])
    sheet.D3={t:'n',f:'SUM(D2:D2)',v:200};sheet['!ref']='A1:D3'
    XLSX.utils.book_append_sheet(wb,sheet,'Формула')
    expect(parseSupplyWorkbook(XLSX.write(wb,{type:'array',bookType:'xlsx'})).products).toHaveLength(1)
    sheet.D3.v=250
    expect(()=>parseSupplyWorkbook(XLSX.write(wb,{type:'array',bookType:'xlsx'}))).toThrow('підсум')
  })
  it('uses raw cached totals, not rounded display text',()=>{
    const wb=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([header,['Ключ',1,1.25,1.25],['Разом','','',1.24]])
    sheet.D3.z='0'
    XLSX.utils.book_append_sheet(wb,sheet,'Ціни')
    expect(()=>parseSupplyWorkbook(XLSX.write(wb,{type:'array',bookType:'xlsx'}))).toThrow('підсум')
  })
  it('does not silently ignore a summary formula without a cached value',()=>{
    const wb=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([header,item,['Разом']])
    sheet.D3={t:'n',f:'SUM(D2:D2)'};sheet['!ref']='A1:D3'
    XLSX.utils.book_append_sheet(wb,sheet,'Формули')
    expect(()=>parseSupplyWorkbook(XLSX.write(wb,{type:'array',bookType:'xlsx'}))).toThrow('формул')
  })
  it('checks a final explicit total in numbered clipboard descriptions, not in the product name',()=>{
    const block='1. Ключ\nКількість: 2 шт\nЗакупівля: 100 грн/шт\n\nРазом за накладною: 200 грн'
    const parsed=parseSupplyText(block)
    expect(parsed.products).toHaveLength(1)
    expect(parsed.products[0].source_name).not.toContain('Разом')
    expect(()=>parseSupplyText(block.replace('200 грн','250 грн'))).toThrow('підсум')
  })
})
