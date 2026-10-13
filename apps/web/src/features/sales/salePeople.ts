import type { SalePerson } from '@/types/sale'

export function salePersonLabel(person: SalePerson | null | undefined): string {
  const name = person?.full_name?.trim()
  if (!name || name === person?.id || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) {
    return 'Не вказано в історичному записі'
  }
  return name + (person?.deleted_at || person?.is_active === false ? ' (неактивний)' : '')
}
