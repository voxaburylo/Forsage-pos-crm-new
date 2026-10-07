import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, it, expect } from 'vitest'
import { LocalDatabase } from '../src/db/localDatabase'
import { LocalCatalogRepository } from '../src/repositories/catalogRepository'
import { LocalSupplyRepository } from '../src/repositories/supplyRepository'
import { DEFAULT_TENANT_ID as tenant } from '../src/db/localTypes'
import { mergeProductsManually, mergeProductFingerprint, type ManualProductMerge } from '../src/repositories/manualProductMerge'
import { AiInvoiceMatcher } from '../src/repositories/aiInvoiceIdentity'

describe('explicit audited duplicate merge (isolated database)', () => {
  let root: string, db: LocalDatabase, catalog: LocalCatalogRepository, supply: LocalSupplyRepository
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'forsage-merge-test-')); db = new LocalDatabase(root); catalog = new LocalCatalogRepository(db); supply = new LocalSupplyRepository(db) })
  afterEach(() => { db.close(); if (path.dirname(root) === tmpdir() && path.basename(root).startsWith('forsage-merge-test-')) rmSync(root, {recursive:true,force:true}) })
  const get = (id: string) => db.prepare('SELECT * FROM products WHERE id=?').get(id)!
  function setup() {
    catalog.upsertProduct({ id:'target',sku:'80457',name:'Электролит AvtoMaster 1L',barcode:'4820108150201',qty_on_hand:1,purchase_price:6000,retail_price:9000 })
    catalog.upsertProduct({ id:'source',sku:'(12)',name:'Электролит 1л AvtoMaster',barcode:'2003782805342',qty_on_hand:5,purchase_price:6300,retail_price:10500 })
  }
  const input = (): ManualProductMerge => ({ operation_id:'test-merge', tenant_id:tenant, source_id:'source',target_id:'target',source_fingerprint:mergeProductFingerprint(get('source')),target_fingerprint:mergeProductFingerprint(get('target')),reason:'Повна назва, бренд і фасування звірені' })
  const snapshot = () => Object.fromEntries(['products','supply_invoice_items','product_barcodes','product_aliases','inventory_movements','audit_log','app_meta','sync_outbox'].map(t=>[t,db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()]))
  it('preserves total stock, both barcodes, source history, prices and a repeat does nothing', () => {
    setup()
    const oldMovements=db.prepare('SELECT * FROM inventory_movements ORDER BY rowid').all()
    const body=input(), result=mergeProductsManually(db,body)
    expect(result.quantity_after).toBe(6)
    expect(get('target')).toMatchObject({qty_on_hand:6,purchase_price:6000,retail_price:9000})
    expect(get('source')).toMatchObject({qty_on_hand:0,is_active:0})
    expect(catalog.findByBarcode('2003782805342')?.id).toBe('target')
    expect(catalog.findByBarcode('4820108150201')?.id).toBe('target')
    expect(catalog.findBySku('(12)')?.id).toBe('target')
    expect(()=>catalog.upsertProduct({id:'source',sku:'(12)',name:'Restore',qty_on_hand:5})).toThrow('об’єднано')
    expect(db.prepare("SELECT operation_type FROM sync_outbox ORDER BY sequence DESC LIMIT 2").all()).toEqual([{operation_type:'product.deleted'},{operation_type:'product.upsert'}])
    expect(db.prepare("SELECT * FROM inventory_movements WHERE source_type<>'product_merge' ORDER BY rowid").all()).toEqual(oldMovements)
    expect(db.prepare("SELECT SUM(qty_delta) n FROM inventory_movements WHERE source_type='product_merge'").get()).toEqual({n:0})
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    const after=snapshot()
    expect(mergeProductsManually(db,body)).toEqual(result); expect(snapshot()).toEqual(after)
    expect(new AiInvoiceMatcher(db,tenant).review({name:'Электролит 1л AvtoMaster',sku:'(12)'})).toMatchObject({status:'matched',product_id:'target'})
  })
  it.each(['posted', 'cancelled'])('keeps %s invoice identity untouched until a mirrored history merge exists', status => {
    setup(); const supplier=supply.saveSupplier({name:'Тест'}).id
    const invoice=supply.createInvoice({supplier_id:supplier,invoice_number:'ONE',items:[{product_id:'source',qty:2,purchase_price:6300}],paid_amount:0})
    supply.postInvoice(invoice.id)
    if (status === 'cancelled') supply.cancelInvoice(invoice.id)
    const before=snapshot()
    expect(()=>mergeProductsManually(db,input())).toThrow(/історія документів/)
    expect(snapshot()).toEqual(before)
    expect(supply.getInvoice(invoice.id).items[0].product_id).toBe('source')
  })
  it('rejects stale plans without touching anything', () => {
    setup();const body=input();db.prepare('UPDATE products SET qty_on_hand=4 WHERE id=?').run('source')
    const before=snapshot();expect(()=>mergeProductsManually(db,body)).toThrow('змінилися');expect(snapshot()).toEqual(before)
  })
  it('blocks open invoices rather than silently changing unfinished work', () => {
    setup();const supplier=supply.saveSupplier({name:'Тест'}).id
    supply.createInvoice({supplier_id:supplier,items:[{product_id:'source',qty:2,purchase_price:6300}],paid_amount:0})
    const before=snapshot();expect(()=>mergeProductsManually(db,input())).toThrow('відкрита накладна');expect(snapshot()).toEqual(before)
  })
  it('blocks barcode ownership on a third card atomically', () => {
    setup();catalog.upsertProduct({id:'third',sku:'third',name:'Інший'})
    db.prepare('UPDATE product_barcodes SET product_id=? WHERE barcode=?').run('third','2003782805342')
    const before=snapshot();expect(()=>mergeProductsManually(db,input())).toThrow('третьою');expect(snapshot()).toEqual(before)
  })
  it('blocks unknown future references rather than losing them', () => {
    setup();db.exec('CREATE TABLE future_table(id TEXT,product_id TEXT)')
    db.prepare('INSERT INTO future_table VALUES(?,?)').run(randomUUID(),'source')
    const before=snapshot();expect(()=>mergeProductsManually(db,input())).toThrow('Невідоме посилання');expect(snapshot()).toEqual(before)
  })
  it('does not accept a repeated operation with another target or evidence', () => {
    setup();const body=input();mergeProductsManually(db,body)
    expect(()=>mergeProductsManually(db,{...body,reason:'other'})).toThrow('іншими даними')
  })
  it('normalizes equivalent piece units but blocks pack conversions and negative stock', () => {
    setup();db.prepare('UPDATE products SET unit=? WHERE id=?').run('ШТ.','source')
    expect(mergeProductsManually(db,input()).quantity_after).toBe(6)
  })
  it.each([{unit:'компл'},{qty_on_hand:-1}])('blocks unsafe units/stock %j', patch => {
    setup();for(const [key,value] of Object.entries(patch))db.prepare('UPDATE products SET '+key+'=? WHERE id=?').run(value,'source')
    const before=snapshot();expect(()=>mergeProductsManually(db,input())).toThrow();expect(snapshot()).toEqual(before)
  })
})
