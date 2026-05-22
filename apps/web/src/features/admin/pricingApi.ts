import { api } from '@/lib/api'

export interface PriceTier {
  id:           string
  name:         string
  discount_pct: number
  is_default:   boolean
  sort_order:   number
  created_at:   string
}

export interface CategoryMarkup {
  id:             string
  category_id:    string
  markup_pct:     number
  min_markup_pct: number
  category?:      { id: string; name: string } | null
}

export const pricingApi = {
  // Цінові рівні
  listTiers: () =>
    api.get<{ data: PriceTier[] }>('/api/v1/pricing/tiers'),

  createTier: (body: { name: string; discount_pct: number; is_default?: boolean }) =>
    api.post<{ data: PriceTier }>('/api/v1/pricing/tiers', body),

  updateTier: (id: string, body: Partial<{ name: string; discount_pct: number; is_default: boolean; sort_order: number }>) =>
    api.put<{ data: PriceTier }>('/api/v1/pricing/tiers/' + id, body),

  deleteTier: (id: string) =>
    api.delete<void>('/api/v1/pricing/tiers/' + id),

  // Наценки категорій
  listMarkups: () =>
    api.get<{ data: CategoryMarkup[] }>('/api/v1/pricing/markups'),

  upsertMarkup: (categoryId: string, body: { markup_pct: number; min_markup_pct?: number }) =>
    api.put<{ data: CategoryMarkup }>('/api/v1/pricing/markups/' + categoryId, body),

  deleteMarkup: (categoryId: string) =>
    api.delete<void>('/api/v1/pricing/markups/' + categoryId),

  // Авто-розрахунок
  autoRetail: (purchaseKopecks: number, categoryId: string) =>
    api.get<{ data: { retail_price: number | null } }>(
      '/api/v1/pricing/auto-retail?purchase=' + purchaseKopecks + '&category_id=' + categoryId
    ),

  // Розрахунок для конкретного клієнта
  calculate: (body: { purchase_price: number; retail_price: number; category_id?: string; customer_id?: string }) =>
    api.post<{ data: { retail_price: number; tier_price: number; discount_pct: number; tier_name: string | null; min_price: number } }>(
      '/api/v1/pricing/calculate', body
    ),
}
