type Person = { id: string; full_name: string | null; is_active: boolean; deleted_at: string | null }
type Query = (sql: string, params: unknown[]) => Promise<{ rows: Person[] }>

export async function readSaleOrderSource(
  query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ is_order_sale: boolean }> }>,
  tenantId: string, saleId: string,
) {
  const { rows } = await query(`SELECT EXISTS (
    SELECT 1 FROM customer_orders o WHERE o.tenant_id = $1 AND o.sale_id = $2
      AND to_jsonb(o)->>'deleted_at' IS NULL
  ) AS is_order_sale`, [tenantId, saleId])
  return rows[0]?.is_order_sale === true
}

/** Names are display data only; scope comes exclusively from trusted app metadata. */
export async function readSalePeople(query: Query, tenantId: string, cashierId: unknown, managerId: unknown) {
  const ids = [...new Set([cashierId, managerId].filter((id): id is string =>
    typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)).map(id => id.toLowerCase()))]
  if (!ids.length) return { cashier: null, manager: null }
  const { rows } = await query(`
    SELECT id, raw_user_meta_data->>'full_name' AS full_name,
      COALESCE(raw_app_meta_data->>'is_active', 'true') <> 'false' AS is_active,
      raw_app_meta_data->>'deleted_at' AS deleted_at
    FROM auth.users
    WHERE id = ANY($1::uuid[]) AND raw_app_meta_data->>'tenant_id' = $2
  `, [ids, tenantId])
  const people = new Map(rows.map(person => [person.id, person]))
  return { cashier: people.get(String(cashierId).toLowerCase()) ?? null, manager: people.get(String(managerId).toLowerCase()) ?? null }
}
