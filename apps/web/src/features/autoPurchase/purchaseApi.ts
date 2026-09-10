import { desktopBridge } from '@/lib/desktopBridge'
import { durableLocalRequest } from '@/lib/durableLocalRequest'
import { useAuthStore } from '@/stores/authStore'

function local() {
  const purchases = desktopBridge()?.purchases
  if (!purchases) throw new Error('Локальні закупівлі недоступні. Потрібна оновлена локальна програма.')
  return purchases
}

export const purchaseApi = {
  listRules: async () => ({ data: await local().listRules() }),
  suggestions: async () => ({ data: await local().suggestions() }),
  supplierNeeds: async () => ({ data: await local().supplierNeeds() }),
  createRule: async (body: { product_id: string; supplier_id: string | null; min_qty: number; max_qty: number }) => ({ data: await local().createRule(body) }),
  deleteRule: async (id: string) => local().deleteRule(id),
  generateInvoices: async () => ({ data: await durableLocalRequest('auto-purchase:' + useAuthStore.getState().session?.user?.id, {}, operation_id => local().generateInvoices({ operation_id })) }),
}
