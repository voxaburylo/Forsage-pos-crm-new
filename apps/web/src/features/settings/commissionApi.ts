import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'

export interface CommissionRule {
  id: string
  tenant_id: string
  user_id: string | null
  brand_id: string | null
  category_id: string | null
  pct_from_revenue: number
  pct_from_profit: number
  rule_type: string
  created_at: string
  updated_at: string
}

export interface CreateCommissionRuleInput {
  user_id?: string | null
  brand_id?: string | null
  category_id?: string | null
  pct_from_revenue: number
  pct_from_profit: number
  rule_type?: string
}

export const commissionApi = {
  listRules: async () => {
    const local = desktopBridge()?.staff?.listCommissionRules
    if (local) return { data: await local() as CommissionRule[] }
    return api.get<{ data: CommissionRule[] }>('/api/v1/commission/rules')
  },
  createRule: async (body: CreateCommissionRuleInput) => {
    const local = desktopBridge()?.staff?.createCommissionRule
    if (local) return { data: await local(body) as CommissionRule }
    return api.post<{ data: CommissionRule }>('/api/v1/commission/rules', body)
  },
  deleteRule: async (id: string) => {
    const local = desktopBridge()?.staff?.deleteCommissionRule
    if (local) { await local(id); return }
    return api.delete<void>(`/api/v1/commission/rules/${id}`)
  },
}
