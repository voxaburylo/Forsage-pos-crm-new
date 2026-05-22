import { api } from '@/lib/api'
import type { CustomerVehicle } from '@/types/customer'

export const customerVehiclesApi = {
  list: (customerId: string) =>
    api.get<{ data: CustomerVehicle[] }>(`/api/v1/customers/${customerId}/vehicles`),

  create: (customerId: string, body: { brand: string; model: string; year?: number | null; vin?: string | null; notes?: string | null }) =>
    api.post<{ data: CustomerVehicle }>(`/api/v1/customers/${customerId}/vehicles`, body),

  delete: (customerId: string, vehicleId: string) =>
    api.delete(`/api/v1/customers/${customerId}/vehicles/${vehicleId}`),
}
