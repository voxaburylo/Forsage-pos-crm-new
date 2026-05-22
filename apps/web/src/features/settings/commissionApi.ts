import { api } from '@/lib/api'

export interface CommissionRule {
  id: string
  tenant_id: string
  user_id: string | null
  brand_id: string | null
  category_id: string | null
  pct_from_revenue: number
  pct_from_profit: number
  created_at: string
  updated_at: string
}

export interface CreateCommissionRuleInput {
  user_id?: string | null
  brand_id?: string | null
  category_id?: string | null
  pct_from_revenue: number
  pct_from_profit: number
}

export const commissionApi = {
  listRules: () => api.get<{ data: CommissionRule[] }>('/api/v1/commission/rules'),
  createRule: (body: CreateCommissionRuleInput) =>
    api.post<{ data: CommissionRule }>('/api/v1/commission/rules', body),
  deleteRule: (id: string) =>
    api.delete<void>(`/api/v1/commission/rules/${id}`),
}
