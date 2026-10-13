export function validReportMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && Number(value.slice(0, 4)) > 0
}

function validWorkDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number(value.slice(0, 4)) > 0 &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}

export function tireLinkContext(params: URLSearchParams, today: string) {
  const requestedPeriod = params.get('period') ?? ''
  const period = validReportMonth(requestedPeriod) ? requestedPeriod : ''
  const requestedDate = params.get('date') ?? ''
  const date = validWorkDate(requestedDate) && requestedDate <= today ? requestedDate : ''
  return { date: date || (period ? '' : today), period: date && !date.startsWith(period) ? '' : period,
    employee: params.get('employee') ?? '' }
}

export function payrollTireHref(employee: string, period: string, workDate?: string | null): string {
  const params = new URLSearchParams({ tab: 'tire', employee })
  if (validReportMonth(period)) params.set('period', period)
  if (workDate && validWorkDate(workDate)) params.set('date', workDate)
  return '/analytics/sales?' + params.toString()
}
