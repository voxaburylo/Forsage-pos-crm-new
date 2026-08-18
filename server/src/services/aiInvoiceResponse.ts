function parseObjectCandidate(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value)
    if (typeof parsed === 'string') return parseObjectCandidate(parsed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function parseAiJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  const text = String(raw ?? '').replace(/^\uFEFF/, '').trim()
  if (!text) return null

  const candidates = new Set<string>([text])
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim()
  if (fenced) candidates.add(fenced)

  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.add(text.slice(firstBrace, lastBrace + 1))
  }

  for (const candidate of candidates) {
    const parsed = parseObjectCandidate(candidate)
    if (parsed) return parsed
  }
  return null
}