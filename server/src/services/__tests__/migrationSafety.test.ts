import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function migration(name: string): string {
  return readFileSync(new URL(`../../../../supabase/migrations/${name}`, import.meta.url), 'utf8')
}

describe('critical migration safety', () => {
  it('tenant-scopes supplier payments and indexes tenant foreign-key lookups', () => {
    const sql = migration('20260717090000_finance_sources_and_supplier_payments.sql')
    expect(sql).toContain('USING (tenant_id = app.user_tenant_id())')
    expect(sql).toContain('WITH CHECK (tenant_id = app.user_tenant_id())')
    expect(sql).toMatch(/FOR ALL\s+TO authenticated\s+USING/)
    expect(sql).not.toContain('USING (true)')
    expect(sql).toContain('supplier_payments(tenant_id, invoice_id')
    expect(sql).toContain('supplier_payments(tenant_id, supplier_id')
    expect(sql).toContain('supplier_payments(tenant_id, shift_id')
  })

  it('records core deposits in order receipt totals and exposes replay state', () => {
    const sql = migration('20260722190000_complete_customer_order_all_items.sql')
    expect(sql).toContain("'replayed', true")
    expect(sql).toContain("'replayed', false")
    expect(sql).toContain('v_item.core_deposit_amount')
    expect(sql).toMatch(/v_subtotal := v_subtotal \+ ROUND\([\s\S]*?core_deposit_amount/)
    expect(sql).toMatch(/INSERT INTO sale_items[\s\S]*?ROUND\([\s\S]*?core_deposit_amount/)
    expect(sql).not.toContain('item_status <> \'handed\'')
  })

  it('fails loudly on barcode ownership conflicts and has no UTF-8 BOM', () => {
    const path = new URL(
      '../../../../supabase/migrations/20260720195500_sync_product_primary_barcodes.sql',
      import.meta.url,
    )
    const bytes = readFileSync(path)
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf])
    const sql = bytes.toString('utf8')
    expect(sql).toContain('BARCODE_ALREADY_EXISTS: Штрихкод')
    expect(sql).toContain('RETURNING product_id INTO v_indexed_product_id')
    expect(sql).toContain('HAVING COUNT(DISTINCT id) > 1')
  })

  it('does not guess a shift for historical cash refunds', () => {
    const sql = migration('20260722213000_return_cash_operations.sql')
    expect(sql).toContain('AFTER INSERT OR UPDATE OF status, refund_method, refund_kopecks, refund_amount')
    expect(sql).toContain('WHERE co.id = NEW.id')
    expect(sql).toContain('RETURN_CASH_OPERATION_CONFLICT')
    expect(sql).not.toMatch(/INSERT INTO cash_operations[\s\S]*?SELECT[\s\S]*?FROM returns r/)
    expect(sql).toContain('ручну касову звірку')
  })

  it('uses trusted app metadata and closes all release RLS gaps', () => {
    const sql = migration('20260723100000_release_security_hardening.sql')
    expect(sql).toContain("auth.jwt() -> 'app_metadata' ->> 'tenant_id'")
    expect(sql).toContain("auth.jwt() -> 'app_metadata' ->> 'role'")
    expect(sql).toContain('FROM public.shifts shift_row')
    expect(sql).toContain('shift_row.cashier_id = user_row.id')
    expect(sql).toContain('HAVING COUNT(*) = 1')
    expect(sql).not.toContain("'00000000-0000-0000-0000-000000000001'::UUID")
    expect(sql).toContain("'payment_reconciliation'")
    expect(sql).toContain("'customer_deposit_transactions'")
    expect(sql).toContain("('product_photos',             'product_id',  'products')")
    expect(sql).toContain('CREATE POLICY release_parent_tenant_all')
    expect(sql).toContain('linked_customer.id = %1$I.customer_id')
    expect(sql).toContain('linked_product.id = %1$I.product_id')
    expect(sql).toContain('linked_supplier.id = %1$I.supplier_id')
    expect(sql).toContain('CREATE POLICY release_product_cobuy_tenant')
    expect(sql).toContain('source_product.id = product_cobuy.product_id')
    expect(sql).toContain('recommended_product.id = product_cobuy.recommended_product_id')
    expect(sql).toContain('WITH CHECK (tenant_id = (SELECT app.user_tenant_id()))')
    expect(sql).toContain('ALTER VIEW public.products_available SET (security_invoker = true)')
    expect(sql).toContain('ALTER VIEW public.v_product_stock SET (security_invoker = true)')
    expect(sql).toContain("NOTIFY pgrst, 'reload schema'")
  })

  it('never applies uncounted inventory rows or rewrites historical snapshots', () => {
    const collaborative = migration('20260717100000_collaborative_inventory.sql')
    const refresh = migration('20260718130104_refresh_inventory_expected_on_first_count.sql')
    expect(collaborative).toMatch(/UPDATE products p[\s\S]*?AND i\.was_counted = true/)
    expect(refresh).not.toMatch(/UPDATE inventory_items i\s+SET expected_stock/)
  })

  it('tenant-scopes order reserve release in replay and completion paths', () => {
    const sql = migration('20260722190000_complete_customer_order_all_items.sql')
    const matches = sql.match(/UPDATE inventory_reserves[\s\S]*?AND tenant_id = p_tenant_id/g) ?? []
    expect(matches).toHaveLength(2)
  })

  it('derives return products from tenant-scoped sale items and disables the legacy RPC', () => {
    const sql = migration('20260723120000_harden_process_return_v2.sql')
    expect(sql).toContain('si.sale_id = p_sale_id')
    expect(sql).toContain('si.tenant_id = p_tenant_id')
    expect(sql).toContain('p.id = si.product_id')
    expect(sql).toContain('p.tenant_id = p_tenant_id')
    expect(sql).toContain('v_requested_product <> v_product_id')
    expect(sql).toMatch(/UPDATE products[\s\S]*?WHERE id = v_product_id[\s\S]*?tenant_id = p_tenant_id/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.process_return\(/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.process_return_v2\([\s\S]*?TO service_role/)
  })
})