const KYIV_TIME_ZONE = 'Europe/Kyiv'

const kyivPartsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: KYIV_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

const kyivDateFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: KYIV_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function parseDateKey(date: string): [number, number, number] {
  const [year, month, day] = date.split('-').map(Number)
  if (!year || !month || !day) throw new Error('INVALID_DATE_KEY')
  return [year, month, day]
}

function localPartsAsUtc(timestamp: number): number {
  const parts = Object.fromEntries(
    kyivPartsFormatter.formatToParts(new Date(timestamp))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  )
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
}

function kyivMidnightUtc(date: string): string {
  const [year, month, day] = parseDateKey(date)
  const targetLocalAsUtc = Date.UTC(year, month - 1, day)
  let guess = targetLocalAsUtc
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const correction = targetLocalAsUtc - localPartsAsUtc(guess)
    guess += correction
    if (Math.abs(correction) < 1_000) break
  }
  return new Date(guess).toISOString()
}

function nextDateKey(date: string): string {
  const [year, month, day] = parseDateKey(date)
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
}

export function kyivDateKey(value: Date = new Date()): string {
  return kyivDateFormatter.format(value)
}

export function kyivDateRange(startDate: string, endDate: string): {
  from: string
  toExclusive: string
} {
  return {
    from: kyivMidnightUtc(startDate),
    toExclusive: kyivMidnightUtc(nextDateKey(endDate)),
  }
}
