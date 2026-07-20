import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { adminApi } from './adminApi'

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

function defaultTiers(): PriceTier[] {
  return [{ id: 'default', name: 'Звичайна ціна', discount_pct: 0, is_default: true, sort_order: 0, created_at: '' }]
}

async function localSettings(): Promise<any> {
  const { data } = await adminApi.getSettings()
  return data as any
}

async function saveLocalSettings(update: Record<string, unknown>): Promise<void> {
  await adminApi.updateSettings(update as any, { silent: true })
}

async function localMarkups(): Promise<CategoryMarkup[]> {
  const settings = await localSettings()
  const categories = await desktopBridge()?.catalog.listCategories?.() ?? []
  const categoryById = new Map(categories.map((category) => [category.id, category]))
  const rows = Array.isArray(settings.category_markups) ? settings.category_markups : []
  return rows.map((row: any) => ({
    id: row.id ?? row.category_id,
    category_id: row.category_id,
    markup_pct: Number(row.markup_pct ?? 0),
    min_markup_pct: Number(row.min_markup_pct ?? 0),
    category: categoryById.get(row.category_id) ?? null,
  }))
}

function roundRetail(retail: number, settings: any): number {
  if (settings.price_rounding_enabled !== true) return retail
  const step = Math.max(1, Number(settings.price_rounding_step) || 100)
  const scaled = retail / step
  return (settings.price_rounding_dir === 'up' ? Math.ceil(scaled)
    : settings.price_rounding_dir === 'down' ? Math.floor(scaled) : Math.round(scaled)) * step
}

export const pricingApi = {
  // Цінові рівні
  listTiers: async () => {
    if (desktopBridge()) {
      const settings = await localSettings()
      const tiers = Array.isArray(settings.price_tiers) && settings.price_tiers.length > 0
        ? settings.price_tiers as PriceTier[]
        : defaultTiers()
      return { data: tiers }
    }
    return api.get<{ data: PriceTier[] }>('/api/v1/pricing/tiers')
  },

  createTier: async (body: { name: string; discount_pct: number; is_default?: boolean }) => {
    if (desktopBridge()) {
      const settings = await localSettings()
      const tiers = Array.isArray(settings.price_tiers) ? settings.price_tiers as PriceTier[] : defaultTiers()
      const next: PriceTier = {
        id: crypto.randomUUID(),
        name: body.name,
        discount_pct: Number(body.discount_pct ?? 0),
        is_default: body.is_default === true,
        sort_order: tiers.length,
        created_at: new Date().toISOString(),
      }
      const updated = body.is_default ? tiers.map((tier) => ({ ...tier, is_default: false })).concat(next) : tiers.concat(next)
      await saveLocalSettings({ price_tiers: updated })
      return { data: next }
    }
    return api.post<{ data: PriceTier }>('/api/v1/pricing/tiers', body)
  },

  updateTier: async (id: string, body: Partial<{ name: string; discount_pct: number; is_default: boolean; sort_order: number }>) => {
    if (desktopBridge()) {
      const settings = await localSettings()
      const tiers = Array.isArray(settings.price_tiers) ? settings.price_tiers as PriceTier[] : defaultTiers()
      let updated = tiers.map((tier) => tier.id === id ? { ...tier, ...body } : tier)
      if (body.is_default === true) updated = updated.map((tier) => ({ ...tier, is_default: tier.id === id }))
      await saveLocalSettings({ price_tiers: updated })
      return { data: updated.find((tier) => tier.id === id) ?? updated[0] }
    }
    return api.put<{ data: PriceTier }>('/api/v1/pricing/tiers/' + id, body)
  },

  deleteTier: async (id: string) => {
    if (desktopBridge()) {
      const settings = await localSettings()
      const tiers = (Array.isArray(settings.price_tiers) ? settings.price_tiers as PriceTier[] : defaultTiers()).filter((tier) => tier.id !== id || tier.is_default)
      await saveLocalSettings({ price_tiers: tiers.length ? tiers : defaultTiers() })
      return undefined as void
    }
    return api.delete<void>('/api/v1/pricing/tiers/' + id)
  },

  // Наценки категорій
  listMarkups: async () => {
    if (desktopBridge()) return { data: await localMarkups() }
    return api.get<{ data: CategoryMarkup[] }>('/api/v1/pricing/markups')
  },

  upsertMarkup: async (categoryId: string, body: { markup_pct: number; min_markup_pct?: number }) => {
    if (desktopBridge()) {
      const settings = await localSettings()
      const rows = Array.isArray(settings.category_markups) ? settings.category_markups as CategoryMarkup[] : []
      const next: CategoryMarkup = {
        id: categoryId,
        category_id: categoryId,
        markup_pct: Number(body.markup_pct ?? 0),
        min_markup_pct: Number(body.min_markup_pct ?? 0),
      }
      const updated = rows.some((row) => row.category_id === categoryId)
        ? rows.map((row) => row.category_id === categoryId ? next : row)
        : rows.concat(next)
      await saveLocalSettings({ category_markups: updated })
      return { data: (await localMarkups()).find((row) => row.category_id === categoryId) ?? next }
    }
    return api.put<{ data: CategoryMarkup }>('/api/v1/pricing/markups/' + categoryId, body)
  },

  deleteMarkup: async (categoryId: string) => {
    if (desktopBridge()) {
      const settings = await localSettings()
      const rows = Array.isArray(settings.category_markups) ? settings.category_markups as CategoryMarkup[] : []
      await saveLocalSettings({ category_markups: rows.filter((row) => row.category_id !== categoryId) })
      return undefined as void
    }
    return api.delete<void>('/api/v1/pricing/markups/' + categoryId)
  },

  // Авто-розрахунок
  autoRetail: async (purchaseKopecks: number, categoryId?: string) => {
    if (desktopBridge()) {
      const settings = await localSettings()
      const categoryMarkup = (Array.isArray(settings.category_markups) ? settings.category_markups : [])
        .find((row: any) => row.category_id === categoryId)
      const rules = Array.isArray(settings.markup_rules) ? settings.markup_rules : []
      const rule = rules.find((candidate: any) => purchaseKopecks >= Number(candidate.minPrice) && purchaseKopecks < Number(candidate.maxPrice))
      const markupPct = Number(categoryMarkup?.markup_pct ?? rule?.markupPct ?? 30)
      const retail = roundRetail(Math.round(purchaseKopecks * (1 + markupPct / 100)), settings)
      return { data: { retail_price: retail } }
    }
    return api.get<{ data: { retail_price: number | null } }>(
      '/api/v1/pricing/auto-retail?purchase=' + purchaseKopecks + (categoryId ? '&category_id=' + categoryId : '')
    )
  },

  // Розрахунок для конкретного клієнта
  calculate: async (body: { purchase_price: number; retail_price: number; category_id?: string; customer_id?: string }) => {
    if (desktopBridge()) {
      const settings = await localSettings()
      const tiers = Array.isArray(settings.price_tiers) ? settings.price_tiers as PriceTier[] : defaultTiers()
      const tier = tiers.find((item) => item.is_default) ?? tiers[0]
      const discountPct = Number(tier?.discount_pct ?? 0)
      const tierPrice = Math.round(Number(body.retail_price ?? 0) * (1 - discountPct / 100))
      return { data: { retail_price: body.retail_price, tier_price: tierPrice, discount_pct: discountPct, tier_name: tier?.name ?? null, min_price: body.purchase_price } }
    }
    return api.post<{ data: { retail_price: number; tier_price: number; discount_pct: number; tier_name: string | null; min_price: number } }>(
      '/api/v1/pricing/calculate', body
    )
  },
}
