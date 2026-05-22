import { api } from '@/lib/api'

export interface CustomerCar {
  id: string
  customer_id: string
  make: string
  model: string
  year: number | null
  vin: string | null
  notes: string | null
  created_at: string
}

interface CreateCarInput {
  customer_id: string
  make: string
  model: string
  year?: number | null
  vin?: string | null
  notes?: string | null
}

export const customerCarsApi = {
  list: (customerId: string) =>
    api.get<{ data: CustomerCar[] }>(`/api/v1/customer-cars/${customerId}`),

  create: (input: CreateCarInput) =>
    api.post<{ data: CustomerCar }>('/api/v1/customer-cars', input),

  update: (id: string, input: Partial<CreateCarInput>) =>
    api.put<{ data: CustomerCar }>(`/api/v1/customer-cars/${id}`, input),

  delete: (id: string) =>
    api.delete(`/api/v1/customer-cars/${id}`),
}
