import { api } from '@/lib/api'
// Єдиний канонічний тип етикетки — з LabelDesigner (повний). import type
// стирається при збірці, тож рантайм-циклу з adminApi не виникає.
import type { LabelSettings } from '@/features/labels/LabelDesigner'

export type { LabelSettings }

// Users
export interface AdminUser {
  id: string
  phone: string
  email: string
  full_name: string
  role: string
  is_active: boolean
  base_rate: number
  created_at: string
}

export type UserRole = 'owner' | 'admin' | 'manager' | 'cashier' | 'storekeeper' | 'sto_viewer'

export const ROLE_LABELS: Record<UserRole, string> = {
  owner:       'Власник',
  admin:       'Адміністратор',
  manager:     'Менеджер',
  cashier:     'Касир',
  storekeeper: 'Кладовщик',
  sto_viewer:  'СТО (перегляд)',
}

// Settings
export interface QuickChildItem {
  label: string
  sku: string
  price?: number
}

export interface QuickItemConfig {
  sku: string
  label: string
  emoji?: string
  price?: number
  color?: string
  children?: QuickChildItem[]
  type?: 'static' | 'food_popup'       // static = фіксована ціна, food_popup = вікно з категоріями
  category_filter?: string[]            // для food_popup: які категорії показувати
}

export interface MarkupRule {
  minPrice: number
  maxPrice: number
  markupPct: number
}

export interface ShopSettings {
  id: string
  shop_name: string
  shop_address: string | null
  phone: string | null
  max_discount_pct: number
  allow_negative_qty: boolean
  return_days: number
  currency: string
  default_debt_limit_kopecks: number
  label_settings?: LabelSettings
  pos_quick_items?: QuickItemConfig[]
  quick_percents?: number[]
  markup_rules?: MarkupRule[]
  employee_discount_pct?: number
  // ПРРО
  prro_enabled:           boolean
  prro_provider:          string   // 'mock' | 'kashalot'
  kashalot_license_key:   string | null
  kashalot_pin:           string | null
  // Банківський термінал
  bank_terminal_enabled:  boolean
  terminal_provider:      string   // 'mock' | 'privatbank'
  privatbank_terminal_ip:   string | null
  privatbank_terminal_port: number | null
  privatbank_merchant_id:   string | null
}

export const adminApi = {
  // Users
  listUsers: () => api.get<{ data: AdminUser[] }>('/api/v1/admin/users'),
  createUser: (body: { phone: string; password: string; full_name: string; role: UserRole; base_rate?: number }) =>
    api.post<{ data: AdminUser }>('/api/v1/admin/users', body),
  updateUser: (id: string, body: { role?: UserRole; is_active?: boolean; full_name?: string; base_rate?: number; phone?: string }) =>
    api.put<{ data: AdminUser }>(`/api/v1/admin/users/${id}`, body),
  deleteUser: (id: string) =>
    api.delete<void>(`/api/v1/admin/users/${id}`),
  resetPassword: (id: string, password: string) =>
    api.put<{ data: { success: boolean } }>(`/api/v1/admin/users/${id}/password`, { password }),

  // Categories
  listCategories: () => api.get<{ data: Array<{ id: string; name: string; sort_order: number }> }>('/api/v1/admin/categories'),
  createCategory: (name: string, sort_order?: number) =>
    api.post('/api/v1/admin/categories', { name, sort_order: sort_order ?? 0 }),
  updateCategory: (id: string, name: string) =>
    api.put(`/api/v1/admin/categories/${id}`, { name }),
  deleteCategory: (id: string) =>
    api.delete(`/api/v1/admin/categories/${id}`),

  // Brands
  listBrands: () => api.get<{ data: Array<{ id: string; name: string; country: string | null }> }>('/api/v1/admin/brands'),
  createBrand: (name: string, country?: string) =>
    api.post('/api/v1/admin/brands', { name, country: country || null }),
  updateBrand: (id: string, body: { name?: string; country?: string | null }) =>
    api.put(`/api/v1/admin/brands/${id}`, body),
  deleteBrand: (id: string) =>
    api.delete(`/api/v1/admin/brands/${id}`),

  // Повне очищення каталогу
  resetCatalog: () =>
    api.post<{ data: { products_deleted: number; categories_deleted: number } }>(
      '/api/v1/admin/reset-catalog',
      { confirmation: 'ВИДАЛИТИ ВСЕ' },
    ),

  // Повне очищення всіх даних
  resetAllData: () =>
    api.post<{ data: { success: boolean } }>(
      '/api/v1/admin/reset-all-data',
      { confirmation: 'ВИДАЛИТИ ВСЕ' },
    ),

  // Settings
  getSettings: () => api.get<{ data: ShopSettings }>('/api/v1/settings'),
  updateSettings: (body: Partial<ShopSettings>) =>
    api.put<{ data: ShopSettings }>('/api/v1/settings', body),
}
