import { api } from '@/lib/api'
import { desktopBridge } from '@/lib/desktopBridge'
import { requestDesktopSync } from '@/features/products/productApi'
import type { CustomerVehicle } from '@/types/customer'

export const customerVehiclesApi = {
  list: async (customerId: string) => {
    const local = desktopBridge()?.pos.listCustomerVehicles
    if (local) return { data: await local(customerId) as CustomerVehicle[] }
    return api.get<{ data: CustomerVehicle[] }>(`/api/v1/customers/${customerId}/vehicles`)
  },

  create: async (customerId: string, body: { brand: string; model: string; year?: number | null; vin?: string | null; notes?: string | null }) => {
    const local = desktopBridge()?.pos.saveCustomerVehicle
    if (local) {
      const data = await local(customerId, body)
      requestDesktopSync()
      return { data: data as CustomerVehicle }
    }
    return api.post<{ data: CustomerVehicle }>(`/api/v1/customers/${customerId}/vehicles`, body)
  },

  update: async (customerId: string, vehicleId: string, body: Partial<{ brand: string; model: string; year: number | null; vin: string | null; notes: string | null }>) => {
    const local = desktopBridge()?.pos.saveCustomerVehicle
    if (local) {
      const data = await local(customerId, body, vehicleId)
      requestDesktopSync()
      return { data: data as CustomerVehicle }
    }
    return api.put<{ data: CustomerVehicle }>(`/api/v1/customers/${customerId}/vehicles/${vehicleId}`, body)
  },

  delete: async (customerId: string, vehicleId: string) => {
    const local = desktopBridge()?.pos.deleteCustomerVehicle
    if (local) {
      await local(customerId, vehicleId)
      requestDesktopSync()
      return
    }
    return api.delete(`/api/v1/customers/${customerId}/vehicles/${vehicleId}`)
  },
}
