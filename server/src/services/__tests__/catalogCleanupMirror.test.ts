import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
const state = vi.hoisted(() => ({ db: null as any, queries: [] as string[] }))
vi.mock('../../db/supabase.js', () => ({ db: {} }))
vi.mock('../../db/pg.js', () => ({ pool: {}, runTransaction: (fn: any) => state.db.transaction((tx: any) => fn({
  query: async (sql: string, args: any[]) => {
    state.queries.push(sql)
    const r = await tx.query(sql, args)
    return { ...r, rowCount: r.rows.length || r.affectedRows || 0 }
  },
})) }))
import { applyCatalogCleanupMirror } from '../sync/catalogCleanupMirror.js'
import { applyProductDeleted, applyProductUpsert } from '../sync/catalogHandlers.js'
const tenant = randomUUID(), target = randomUUID(), source = randomUUID(), user = randomUUID()
const when = '2026-10-13T10:00:00.000Z'
function operation() {
  const merge = randomUUID()
  return { sequence: 1, operation_id: randomUUID(), tenant_id: tenant, device_id: 'main', aggregate_type: 'product',
    aggregate_id: target, operation_type: 'product.catalog_cleanup', created_at: when, applied_at: when, balance_mirrored: true,
    payload: { version: 1, operation_id: merge, target_id: target, source_ids: [source], stock_review: 'pending',
      reason: 'Reviewed duplicate', user_id: user, merged_at: when,
      products: [
        { id: target, tenant_id: tenant, sku: 'A123', name: 'Target', qty_on_hand: 8, purchase_price: 100, retail_price: 200, brand_id: null,
          barcode: 'T100', deleted_at: null, is_active: true, specs: { cleanup_sources: [{ id: source, sku: 'B123', merge_operation_id: merge }],
            cleanup_stock_review: { status: 'pending', user_id: user, at: when, operation_id: merge } } },
        { id: source, tenant_id: tenant, sku: 'B123', name: 'Source', qty_on_hand: 0, barcode: 'S100', deleted_at: when, is_active: false,
          specs: { merged_into_product_id: target, merge_operation_id: merge } },
      ],
      barcodes: [{ id: randomUUID(), tenant_id: tenant, product_id: target, barcode: 'T100', is_primary: 1, barcode_type: 'ean13', created_at: when, updated_at: when, deleted_at: null },
        { id: randomUUID(), tenant_id: tenant, product_id: target, barcode: 'S100', is_primary: 0, barcode_type: 'ean13', created_at: when, updated_at: when, deleted_at: null }],
      aliases: [{ id: randomUUID(), tenant_id: tenant, product_id: target, alias: 'Source', created_at: when, updated_at: when, deleted_at: null }],
      cross_numbers: [{ id: randomUUID(), tenant_id: tenant, product_id: target, cross_number: 'OE-123', brand: null, source: 'manual', notes: null, created_at: when, updated_at: when, deleted_at: null }],
    } }
}
beforeEach(async () => {
  state.db = new PGlite(); state.queries = []
  await state.db.exec(`CREATE TABLE products(id uuid PRIMARY KEY,tenant_id uuid,sku text,name text,barcode text,brand_id uuid,category_id uuid,unit text DEFAULT 'шт',
    purchase_price bigint DEFAULT 100,retail_price bigint DEFAULT 200,qty_on_hand numeric,reorder_point numeric DEFAULT 0,notes text,
    is_active boolean DEFAULT true,is_service boolean DEFAULT false,requires_core_return boolean DEFAULT false,core_deposit_amount bigint DEFAULT 0,
    storage_bin text,is_favorite boolean DEFAULT false,photo_url text,specs jsonb DEFAULT '{}',additional_barcodes jsonb DEFAULT '[]',created_at timestamptz,updated_at timestamptz,deleted_at timestamptz,
    UNIQUE(tenant_id,sku));
    CREATE TABLE brands(id uuid PRIMARY KEY,tenant_id uuid,deleted_at timestamptz);
    CREATE TABLE categories(id uuid PRIMARY KEY,tenant_id uuid,deleted_at timestamptz);
    CREATE TABLE product_barcodes(id uuid PRIMARY KEY,tenant_id uuid,product_id uuid REFERENCES products(id),barcode text,barcode_type text,is_primary boolean,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz,UNIQUE(tenant_id,barcode));
    CREATE TABLE product_aliases(id uuid PRIMARY KEY,tenant_id uuid,product_id uuid REFERENCES products(id),alias text,created_at timestamptz,updated_at timestamptz,deleted_at timestamptz);
    CREATE TABLE product_cross_numbers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid,product_id uuid REFERENCES products(id),number text,normalized_number text,number_type text,brand text,source text,is_verified boolean,created_at timestamptz DEFAULT now(),updated_at timestamptz,deleted_at timestamptz,UNIQUE(tenant_id,product_id,normalized_number));
    CREATE TABLE local_balance_mirror(tenant_id uuid,entity_type text,entity_id uuid,balances jsonb,PRIMARY KEY(tenant_id,entity_type,entity_id));
    CREATE TABLE sale_items(id uuid,product_id uuid,qty numeric,price bigint);
    INSERT INTO products(id,tenant_id,sku,name,barcode,qty_on_hand,purchase_price,retail_price) VALUES('${target}','${tenant}','A123','Target','T100',3,444,555),('${source}','${tenant}','B123','Source','S100',0,100,200);
    INSERT INTO local_balance_mirror VALUES('${tenant}','product','${target}','{"qty_on_hand":3}'),('${tenant}','product','${source}','{"qty_on_hand":0}');
    INSERT INTO sale_items VALUES(gen_random_uuid(),'${source}',2,62500);`)
})
afterEach(async () => state.db.close())
const products = async () => (await state.db.query('SELECT * FROM products ORDER BY id')).rows

describe('transactional local catalog cleanup mirror', () => {
  it('preserves current signed quantities, later prices, and historical documents; moves only catalog metadata', async () => {
    const op = operation(), before = (await state.db.query('SELECT * FROM sale_items')).rows
    await applyCatalogCleanupMirror(tenant, op)
    const rows = await products(), t = rows.find((r: any) => r.id === target), s = rows.find((r: any) => r.id === source)
    expect([Number(t.qty_on_hand), Number(t.purchase_price), Number(t.retail_price)]).toEqual([3,444,555])
    expect(s).toMatchObject({ is_active: false, specs: { merged_into_product_id: target, merge_operation_id: op.payload.operation_id } })
    expect((await state.db.query('SELECT barcode,product_id FROM product_barcodes ORDER BY barcode')).rows).toEqual([{ barcode:'S100',product_id:target },{ barcode:'T100',product_id:target }])
    expect((await state.db.query('SELECT * FROM sale_items')).rows).toEqual(before)
    expect(state.queries.some(sql => /ORDER BY id FOR UPDATE/.test(sql))).toBe(true)
  })
  it('acknowledges exact retry without overwriting subsequent stock, price or metadata and rejects changed provenance', async () => {
    const op = operation(); await applyCatalogCleanupMirror(tenant, op)
    await state.db.query('UPDATE products SET qty_on_hand=2,retail_price=777 WHERE id=$1',[target])
    await applyCatalogCleanupMirror(tenant, op)
    expect((await products()).find((r: any) => r.id === target)).toMatchObject({ qty_on_hand:'2',retail_price:777 })
    const changed = structuredClone(op); changed.payload.reason = 'different'
    await expect(applyCatalogCleanupMirror(tenant, changed)).rejects.toMatchObject({ code:'SYNC_CATALOG_CLEANUP_CONFLICT' })
    expect((await state.db.query('SELECT * FROM product_aliases')).rows).toHaveLength(1)
  })
  it('requires all cards, matching tenants, verified balances and zero source stock before any mutation', async () => {
    const op = operation()
    await expect(applyCatalogCleanupMirror(tenant,{...op,balance_mirrored:false})).rejects.toMatchObject({code:'SYNC_CATALOG_CLEANUP_INVALID'})
    await expect(applyCatalogCleanupMirror(randomUUID(),op)).rejects.toThrow()
    await state.db.query('DELETE FROM local_balance_mirror WHERE entity_id=$1',[source])
    await expect(applyCatalogCleanupMirror(tenant,op)).rejects.toThrow()
    expect((await products()).find((r:any)=>r.id===source).deleted_at).toBeNull()
  })
  it('fails closed for a missing parent or SKU divergence rather than inventing cards', async () => {
    const op=operation(); await state.db.query('UPDATE products SET sku=$1 WHERE id=$2',['OTHER',source])
    await expect(applyCatalogCleanupMirror(tenant,op)).rejects.toMatchObject({code:'SYNC_CATALOG_CLEANUP_CONFLICT'})
    await state.db.query('DELETE FROM products WHERE id=$1',[source])
    await expect(applyCatalogCleanupMirror(tenant,op)).rejects.toMatchObject({code:'SYNC_CATALOG_CLEANUP_CONFLICT'})
    expect(await products()).toHaveLength(1)
  })
  it('rejects barcode theft and a metadata ID owned by another tenant atomically', async () => {
    const op=operation(), outsider=randomUUID(), foreign=randomUUID()
    await state.db.query('INSERT INTO products(id,tenant_id,sku,name,barcode,qty_on_hand) VALUES($1,$2,$3,$4,$5,0)',[outsider,tenant,'OTHER','Other','S100'])
    await expect(applyCatalogCleanupMirror(tenant,op)).rejects.toMatchObject({code:'SYNC_CATALOG_CLEANUP_CONFLICT'})
    await state.db.query('DELETE FROM products WHERE id=$1',[outsider])
    await state.db.query('INSERT INTO product_aliases(id,tenant_id,product_id,alias) VALUES($1,$2,$3,$4)',[op.payload.aliases[0].id,foreign,target,'Foreign'])
    await expect(applyCatalogCleanupMirror(tenant,op)).rejects.toMatchObject({code:'SYNC_CATALOG_CLEANUP_CONFLICT'})
    expect((await products()).find((r:any)=>r.id===source).deleted_at).toBeNull()
    expect((await state.db.query('SELECT * FROM product_barcodes')).rows).toHaveLength(0)
  })
  it('does not resurrect a merged tombstone through stale or newer ordinary product upserts', async () => {
    const op=operation(); await applyCatalogCleanupMirror(tenant,op)
    for(const updated_at of ['2026-01-01T00:00:00Z','2027-01-01T00:00:00Z'])
      await applyProductUpsert(tenant,{...op,aggregate_id:source,operation_type:'product.upsert',payload:{id:source,sku:'B123',name:'Restored?',is_active:true,qty_on_hand:40,stock_correction:true,specs:{},updated_at}})
    const s=(await products()).find((r:any)=>r.id===source)
    expect(s.is_active).toBe(false); expect(Number(s.qty_on_hand)).toBe(0)
    expect(s.specs.merged_into_product_id).toBe(target)
  })
  it('rejects mismatched alias identity and duplicate normalized cross keys without partial writes', async () => {
    const op=operation()
    await state.db.query('INSERT INTO product_aliases(id,tenant_id,product_id,alias) VALUES($1,$2,$3,$4)',[op.payload.aliases[0].id,tenant,source,'Other existing alias'])
    op.payload.aliases.push({...op.payload.aliases[0],id:randomUUID(),alias:'Other existing alias'})
    await expect(applyCatalogCleanupMirror(tenant,op)).rejects.toMatchObject({code:'SYNC_CATALOG_CLEANUP_CONFLICT'})
    await state.db.query('DELETE FROM product_aliases')
    const duplicate=operation();duplicate.payload.cross_numbers.push({...duplicate.payload.cross_numbers[0],id:randomUUID(),cross_number:'OE123'})
    await expect(applyCatalogCleanupMirror(tenant,duplicate)).rejects.toMatchObject({code:'SYNC_CATALOG_CLEANUP_INVALID'})
    expect((await products()).find((r:any)=>r.id===source).deleted_at).toBeNull()
  })
  it('retains source cross-number annotations when the target already has the same cross number', async () => {
    const op=operation(), sourceCross={...op.payload.cross_numbers[0],id:randomUUID(),product_id:source,notes:'source annotation'}
    op.payload.cross_numbers.push(sourceCross)
    await state.db.query(`INSERT INTO product_cross_numbers(id,tenant_id,product_id,number,normalized_number,source,brand,is_verified)
      VALUES($1,$2,$3,'OE-123','OE123','source catalogue','Balaton',true)`,[sourceCross.id,tenant,source])
    await applyCatalogCleanupMirror(tenant,op)
    expect((await state.db.query('SELECT product_id,source FROM product_cross_numbers ORDER BY product_id')).rows)
      .toEqual(expect.arrayContaining([{product_id:source,source:'source catalogue'},{product_id:target,source:'manual'}]))
    const t=(await products()).find((r:any)=>r.id===target)
    expect(t.specs.cleanup_mirror_receipts[op.payload.operation_id].cross_notes).toContainEqual({id:sourceCross.id,number:'OE-123',notes:'source annotation'})
  })
  it('mirrors only the source barcode history, including prior labels, and cannot erase it through product upsert', async () => {
    const op:any=operation()
    op.payload.products[0].specs.cleanup_sources[0].specs={cleanup_barcodes:['PREVIOUS-LABEL']}
    op.payload.products[1].specs.cleanup_barcodes=['S100','PREVIOUS-LABEL']
    await applyCatalogCleanupMirror(tenant,op)
    const s=(await products()).find((r:any)=>r.id===source)
    expect(s.specs.cleanup_barcodes).toEqual(['S100','PREVIOUS-LABEL'])
    expect(s.specs.cleanup_barcodes).not.toContain('T100')
    await applyProductUpsert(tenant,{...op,sequence:2,aggregate_id:source,operation_type:'product.upsert',payload:{id:source,specs:{cleanup_barcodes:[]}}})
    expect((await products()).find((r:any)=>r.id===source).specs.cleanup_barcodes).toEqual(['S100','PREVIOUS-LABEL'])
  })
  it('ignores stale target catalog writes/deletes and retains merge provenance in a later legitimate edit', async () => {
    const op=operation(); await applyCatalogCleanupMirror(tenant,op)
    const stale={...op,aggregate_id:target,operation_type:'product.upsert',payload:{id:target,sku:'A123',name:'Old',specs:{},barcode:'T100',additional_barcodes:[],updated_at:'2026-01-01T00:00:00Z'}}
    await applyProductUpsert(tenant,stale)
    await applyProductDeleted(tenant,{...stale,operation_type:'product.deleted'})
    expect((await products()).find((r:any)=>r.id===target)).toMatchObject({name:'Target',deleted_at:null})
    await applyProductUpsert(tenant,{...stale,sequence:2,payload:{id:target,sku:'A123',name:'Renamed',specs:{colour:'black'}}})
    expect((await products()).find((r:any)=>r.id===target).specs).toMatchObject({colour:'black',cleanup_sources:op.payload.products[0].specs.cleanup_sources})
    await applyCatalogCleanupMirror(tenant,op)
    await applyProductDeleted(tenant,{...op,sequence:3,operation_type:'product.deleted',payload:{id:target}})
    expect((await products()).find((r:any)=>r.id===target).deleted_at).not.toBeNull()
  })
})
