import { api } from '@/lib/api'

// Users
export interface AdminUser {
  id: string
  phone: string
  full_name: string
  role: string
  is_active: boolean
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
export interface ShopSettings {
  id: string
  shop_name: string
  shop_address: string | null
  phone: string | null
  max_discount_pct: number
  allow_negative_qty: boolean
  return_days: number
  currency: string
}

export const adminApi = {
  // Users
  listUsers: () => api.get<{ data: AdminUser[] }>('/api/v1/admin/users'),
  createUser: (body: { phone: string; password: string; full_name: string; role: UserRole }) =>
    api.post<{ data: AdminUser }>('/api/v1/admin/users', body),
  updateUser: (id: string, body: { role?: UserRole; is_active?: boolean; full_name?: string }) =>
    api.put<{ data: AdminUser }>(`/api/v1/admin/users/${id}`, body),
  deactivateUser: (id: string) =>
    api.delete<void>(`/api/v1/admin/users/${id}`),

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
  updateBrand: (id: string, name: string) =>
    api.put(`/api/v1/admin/brands/${id}`, { name }),

  // Settings
  getSettings: () => api.get<{ data: ShopSettings }>('/api/v1/settings'),
  updateSettings: (body: Partial<ShopSettings>) =>
    api.put<{ data: ShopSettings }>('/api/v1/settings', body),
}
