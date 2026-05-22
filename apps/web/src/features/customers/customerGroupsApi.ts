import { api } from '@/lib/api'

export interface CustomerGroup {
  id: string
  name: string
  color: string
  sort_order: number
  members?: Array<{ count: number }>
}

export const customerGroupsApi = {
  list: () =>
    api.get<{ data: CustomerGroup[] }>('/api/v1/customer-groups'),

  create: (body: { name: string; color?: string; sort_order?: number }) =>
    api.post<{ data: CustomerGroup }>('/api/v1/customer-groups', body),

  update: (id: string, body: Partial<CustomerGroup>) =>
    api.patch<{ data: CustomerGroup }>(`/api/v1/customer-groups/${id}`, body),

  delete: (id: string) =>
    api.delete<void>(`/api/v1/customer-groups/${id}`),

  addMembers: (groupId: string, customerIds: string[]) =>
    api.post<{ data: { added: number } }>(`/api/v1/customer-groups/${groupId}/members`, { customer_ids: customerIds }),

  removeMember: (groupId: string, customerId: string) =>
    api.delete<void>(`/api/v1/customer-groups/${groupId}/members/${customerId}`),
}
