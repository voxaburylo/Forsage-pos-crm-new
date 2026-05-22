import { api } from '@/lib/api'
import type {
  CustomerReturn,
  PaginatedReturns,
  SaleForReturn,
  CreateReturnBody,
} from '@/types/return'

export const returnApi = {
  list: (page = 1) =>
    api.get<PaginatedReturns>('/api/v1/returns?page=' + page + '&per_page=20'),

  get: (id: string) =>
    api.get<{ data: CustomerReturn }>('/api/v1/returns/' + id),

  getSaleItems: (saleId: string) =>
    api.get<{ data: SaleForReturn }>('/api/v1/returns/sale/' + saleId + '/items'),

  create: (body: CreateReturnBody) =>
    api.post<{ data: CustomerReturn }>('/api/v1/returns', body),
}