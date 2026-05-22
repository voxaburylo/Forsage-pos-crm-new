import { api } from '@/lib/api'
import type { PaginatedAuditLog } from '@/types/auditLog'

interface AuditFilters {
  entity_type?: string
  date_from?:   string
  date_to?:     string
  page?:        number
  per_page?:    number
}

function buildQuery(f: AuditFilters): string {
  const p = new URLSearchParams()
  Object.entries(f).forEach(([k, v]) => {
    if (v !== undefined && v !== '') p.set(k, String(v))
  })
  return p.toString() ? '?' + p.toString() : ''
}

export const auditApi = {
  list: (filters: AuditFilters = {}) =>
    api.get<PaginatedAuditLog>('/api/v1/audit' + buildQuery(filters)),
}
