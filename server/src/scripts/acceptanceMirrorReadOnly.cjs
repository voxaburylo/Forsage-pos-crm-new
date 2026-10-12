// Explicitly scoped diagnostic, never sync/repair. Both databases are read-only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { Client, types } = require('pg')
// PostgreSQL DATE is a calendar day, not midnight in the machine's timezone.
types.setTypeParser(1082, value => value)
const remoteTables = { customer_returns: 'returns', customer_return_items: 'return_items' }
const remoteColumns = { sale_items: { purchase_price: 'cost_price' } }
const nonComparable = {
  inventory_movements: 'Movement IDs and derived events are not a one-to-one mirror contract; compare balances separately.',
  cash_operations: 'Local ledger includes sale/return/payment-derived rows; remote stores their documents separately. Raw ID counts are not a reconciliation.',
}
const scope = {
  products: ['sku', 'barcode', 'name', 'qty_on_hand', 'purchase_price', 'retail_price', 'is_active', 'is_service'],
  sales: ['status', 'total', 'cash_amount', 'card_amount', 'transfer_amount', 'debt_amount', 'is_debt', 'payment_method', 'cashier_id', 'manager_id', 'completed_at'],
  sale_items: ['sale_id', 'product_id', 'qty', 'unit_price', 'purchase_price', 'discount', 'total'],
  sale_payments: ['sale_id', 'method', 'amount'],
  customer_returns: ['sale_id', 'status', 'refund_kopecks', 'refund_method', 'stock_action'],
  customer_return_items: ['return_id', 'sale_item_id', 'product_id', 'quantity', 'total_kopecks'],
  supply_invoices: ['supplier_id', 'invoice_number', 'status', 'total', 'paid_amount'],
  supply_invoice_items: ['invoice_id', 'product_id', 'qty', 'purchase_price'],
  supplier_payments: ['supplier_id', 'amount', 'payment_method'],
  inventory_movements: ['product_id', 'source_type', 'source_id', 'qty_delta', 'qty_after'],
  customer_orders: ['status', 'sale_id', 'manager_id', 'total_amount', 'total_paid'],
  customer_order_items: ['order_id', 'product_id', 'sku', 'qty', 'sell_price', 'buy_price'],
  order_payments: ['order_id', 'amount', 'method'],
  shifts: ['cashier_id', 'status', 'opening_cash', 'closing_cash'],
  cash_operations: ['shift_id', 'type', 'amount'],
  salary_payments: ['employee_id', 'type', 'amount', 'source', 'work_date', 'period'],
}
const quote = name => { assert(/^[a-z_]+$/.test(name)); return '"' + name + '"' }
const fileHash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function canonical(value, dataType, field) {
  if (value === null || value === undefined) return null
  if (dataType === 'boolean') return value === true || value === 1
  if (['numeric', 'integer', 'bigint', 'double precision', 'real', 'smallint'].includes(dataType)) return Number(value)
  if (dataType === 'date' || field === 'work_date') {
    assert(!(value instanceof Date), 'Calendar dates must be read as strings')
    return String(value).slice(0, 10)
  }
  if (value instanceof Date || dataType.startsWith('timestamp')) {
    const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : String(value)
  }
  return value
}
function normalizedRow(table, row) {
  if (table === 'sales' && row.debt_amount == null) return { ...row,
    debt_amount: row.is_debt || row.payment_method === 'debt'
      ? Number(row.total) - Number(row.cash_amount) - Number(row.card_amount) - Number(row.transfer_amount) : 0 }
  return row
}
async function main() {
  const [localPath, reportPath] = process.argv.slice(2)
  assert(localPath && path.isAbsolute(localPath) && fs.statSync(localPath).isFile())
  assert(reportPath && path.isAbsolute(reportPath) && reportPath.endsWith('.json') && !fs.existsSync(reportPath))
  const dbUrl = new URL(process.env.DATABASE_URL), apiUrl = new URL(process.env.SUPABASE_URL)
  assert(dbUrl.hostname.endsWith('.pooler.supabase.com'), 'Use the configured Supabase pooler only')
  assert(apiUrl.hostname.endsWith('.supabase.co'))
  assert(decodeURIComponent(dbUrl.username).endsWith('.' + apiUrl.hostname.split('.')[0]), 'DB and API project differ')
  const tenant = '00000000-0000-0000-0000-000000000001'
  const before = fileHash(localPath), started = performance.now()
  const local = new DatabaseSync(localPath, { readOnly: true, timeout: 2000 })
  const remote = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000,
    query_timeout: 12000, application_name: 'forsage-acceptance-readonly' })
  const detail = {}, summary = []
  let connected = false, transaction = false
  try {
    local.exec('PRAGMA query_only=ON; BEGIN')
    await remote.connect(); connected = true
    await remote.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true
    await remote.query("SET LOCAL statement_timeout='10s'")
    await remote.query("SET LOCAL idle_in_transaction_session_timeout='30s'")
    assert.equal((await remote.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on')
    const schema = (await remote.query(`SELECT table_name,column_name,data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name=ANY($1::text[])`, [Object.keys(scope).map(table => remoteTables[table] || table)])).rows
    for (const [table, expected] of Object.entries(scope)) {
      if (nonComparable[table]) { summary.push({ table, checked: false, reason: nonComparable[table] }); continue }
      const remoteTable = remoteTables[table] || table
      const remoteColumn = field => remoteColumns[table]?.[field] || field
      const localColumns = new Set(local.prepare('PRAGMA table_info(' + quote(table) + ')').all().map(row => row.name))
      const actualRemoteTypes = new Map(schema.filter(row => row.table_name === remoteTable).map(row => [row.column_name, row.data_type]))
      const remoteTypes = new Map([...actualRemoteTypes, ...Object.entries(remoteColumns[table] || {}).filter(([, name]) => actualRemoteTypes.has(name)).map(([name, target]) => [name, actualRemoteTypes.get(target)])])
      const parentScoped = table === 'customer_order_items' && !remoteTypes.has('tenant_id') && remoteTypes.has('order_id')
      if (!localColumns.has('id') || !remoteTypes.has('id') || !localColumns.has('tenant_id') || (!remoteTypes.has('tenant_id') && !parentScoped)) {
        summary.push({ table, checked: false, reason: 'table or tenant scope not available on both sides' }); continue
      }
      const fields = expected.filter(field => localColumns.has(field) && remoteTypes.has(field))
      const metadata = ['updated_at', 'created_at', 'local_updated_at', 'dirty_at'].filter(field => localColumns.has(field) && remoteTypes.has(field))
      const columns = ['id', ...fields, ...metadata]
      const activeLocal = (localColumns.has('deleted_at') ? ' AND deleted_at IS NULL' : '')
        + (table === 'customer_order_items' ? ' AND EXISTS (SELECT 1 FROM customer_orders p WHERE p.id=customer_order_items.order_id AND p.tenant_id=customer_order_items.tenant_id AND p.deleted_at IS NULL)' : '')
      const activeRemote = remoteTypes.has('deleted_at') ? ' AND t.deleted_at IS NULL' : ''
      const source = local.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(table)} WHERE tenant_id=?${activeLocal}`).all(tenant).map(row => normalizedRow(table, row))
      const remoteTenant = parentScoped ? 'EXISTS (SELECT 1 FROM public.customer_orders p WHERE p.id=t.order_id AND p.tenant_id=$1 AND p.deleted_at IS NULL)' : 't.tenant_id=$1'
      const mirror = (await remote.query(`SELECT ${columns.map(field => 't.' + quote(remoteColumn(field)) + ' AS ' + quote(field)).join(',')} FROM public.${quote(remoteTable)} t WHERE ${remoteTenant}${activeRemote}`, [tenant])).rows.map(row => normalizedRow(table, row))
      assert(source.length < 150000 && mirror.length < 150000, 'Audit row limit exceeded')
      const byId = new Map(mirror.map(row => [row.id, row])), sourceIds = new Set(source.map(row => row.id))
      const differences = [], fieldCounts = {}
      for (const row of source) {
        const target = byId.get(row.id)
        if (!target) continue
        const changed = {}
        for (const field of fields) {
          const left = canonical(row[field], remoteTypes.get(field), field), right = canonical(target[field], remoteTypes.get(field), field)
          const equal = typeof left === 'number' && typeof right === 'number' ? Math.abs(left - right) < .00001 : left === right
          if (!equal) { changed[field] = { local: left, remote: right }; fieldCounts[field] = (fieldCounts[field] || 0) + 1 }
        }
        if (Object.keys(changed).length) differences.push({ id: row.id, changed,
          metadata: Object.fromEntries(metadata.map(field => [field, { local: row[field], remote: target[field] }])) })
      }
      const missingRemote = source.filter(row => !byId.has(row.id)).map(row => row.id)
      const missingLocal = mirror.filter(row => !sourceIds.has(row.id)).map(row => row.id)
      detail[table] = { differences, missingRemote, missingLocal }
      summary.push({ table, remoteTable, checked: true, local: source.length, remote: mirror.length,
        missingRemote: missingRemote.length, missingLocal: missingLocal.length,
        differingRows: differences.length, fieldCounts, fields,
        unsupportedFields: expected.filter(field => !fields.includes(field)) })
    }
    await remote.query('ROLLBACK'); transaction = false
    local.exec('ROLLBACK')
    const sourceUnchanged = fileHash(localPath) === before
    const result = { at: new Date().toISOString(), readOnly: true, sourceUnchanged, sourceHash: before,
      auditVersion: 3,
      note: 'Field-level read-only comparison with verified table/column/date/debt mappings; not proof of atomic cross-machine snapshot, access control, or safe repair. Missing/deleted states and derived ledgers require review.',
      elapsedMs: Math.round(performance.now() - started), summary, detail }
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), { flag: 'wx' })
    console.log(JSON.stringify({ readOnly: true, sourceUnchanged, elapsedMs: result.elapsedMs, summary, reportPath }, null, 2))
  } finally {
    if (transaction) await remote.query('ROLLBACK').catch(() => {})
    if (connected) await remote.end()
    local.close()
  }
}
module.exports = { canonical, normalizedRow, remoteTables, remoteColumns }
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ failed: true, code: error.code || error.name })); process.exitCode = 1 })
