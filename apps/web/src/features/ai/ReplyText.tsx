import { Fragment } from 'react'

export type ReplyPart = { text: string; bold: boolean }

/**
 * Відповідь помічника приходить із розміткою: **жирний**, «## заголовок». Раніше вона показувалась як є —
 * із зірочками (24.11.2026, фото власника: «**Нові категорії**, які створить каса»). Розбираємо лише це:
 * жодного HTML із тексту не виконуємо, усе інше лишається текстом.
 */
export function replyParts(text: string): ReplyPart[] {
  const parts: ReplyPart[] = []
  const lines = String(text ?? '').split('\n').map(line => {
    const heading = line.match(/^\s{0,3}#{1,4}\s+(.*)$/)
    return heading ? '**' + heading[1].replace(/\*\*/g, '') + '**' : line
  })
  const pattern = /\*\*([^*\n]+?)\*\*/g
  const source = lines.join('\n')
  let last = 0
  for (const match of source.matchAll(pattern)) {
    if (match.index > last) parts.push({ text: source.slice(last, match.index), bold: false })
    parts.push({ text: match[1], bold: true })
    last = match.index + match[0].length
  }
  if (last < source.length) parts.push({ text: source.slice(last), bold: false })
  return parts
}

export function ReplyText({ text }: { text: string }) {
  return <>{replyParts(text).map((part, index) => part.bold ? <strong key={index} className="font-semibold">{part.text}</strong> : <Fragment key={index}>{part.text}</Fragment>)}</>
}
