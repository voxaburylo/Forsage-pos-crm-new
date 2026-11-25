import { useEffect, useState } from 'react'
import { Card } from '@/components/ui'
import { api } from '@/lib/api'

/**
 * 25.11.2026 (власник: «усе, що можна витягнути по API, — витягуй»): опис товару від Омеги в картці —
 * характеристики, OE-номери з моделлю авто, застосовність. Суцільного тексту й схем Омега в API не дає.
 */
type Spec = { key: string; value: string; descr: string | null }
type Oe = { code: string; code_key: string; car_model: string }
type Node = { name: string; children: Node[] }
export interface SupplierDetailsItem { number: string; brand: string | null; name: string; oe_codes: Oe[]; applicability: Node[]; specifications: Spec[] }
export interface SupplierDetailsAnswer { query: string; items: SupplierDetailsItem[]; pending: boolean }

/** Застосовність коротко: «Марка: модель, модель…» — не більше limit рядків. */
export function applicabilityLines(nodes: Node[], limit = 12): string[] {
  const lines: string[] = []
  for (const make of nodes) {
    if (lines.length >= limit) break
    const models = (make.children ?? []).map(model => model.name).filter(Boolean)
    lines.push(models.length ? `${make.name}: ${models.slice(0, 8).join(', ')}${models.length > 8 ? ` і ще ${models.length - 8}` : ''}` : make.name)
  }
  return lines
}

export function SupplierProductDetails({ sku }: { sku: string | null | undefined }) {
  const [answer, setAnswer] = useState<SupplierDetailsAnswer | null>(null)
  const [failed, setFailed] = useState(false)
  const query = String(sku ?? '').trim()
  const usable = query.replace(/[^\p{L}\p{N}]/gu, '').length >= 3
  useEffect(() => {
    if (!usable) return
    let active = true
    setAnswer(null); setFailed(false)
    api.get<{ data: SupplierDetailsAnswer }>('/api/v1/supplier-offers/details?q=' + encodeURIComponent(query), { silent: true, timeoutMs: 60_000 })
      .then(response => { if (active) setAnswer(response.data) }, () => { if (active) setFailed(true) })
    return () => { active = false }
  }, [query, usable])
  // Немає в Омеги або не вдалося — картку не захаращуємо.
  if (!usable || failed || !answer || (!answer.items.length && !answer.pending)) return null
  const item = answer.items[0]
  return (
    <Card>
      <div data-supplier-details>
        <h3 className="mb-1 font-semibold text-gray-800">Опис від Омеги</h3>
        {!item && <p className="text-sm text-gray-500">Опис ще не завантажено (ліміт запитів на цю годину). Відкрийте пізніше.</p>}
        {item && (
          <div className="space-y-3 text-sm">
            <p className="text-xs text-gray-500">{item.name}{item.brand ? ' · ' + item.brand : ''} · {item.number}</p>
            {item.specifications.length > 0 && (
              <table className="w-full text-sm"><tbody>
                {item.specifications.slice(0, 40).map((spec, index) => (
                  <tr key={index} className="border-b border-gray-100 last:border-0">
                    <td className="py-1 pr-3 text-gray-500">{spec.key}</td>
                    <td className="py-1 font-medium text-gray-900">{spec.value}{spec.descr ? <span className="ml-1 text-xs text-gray-400">{spec.descr}</span> : null}</td>
                  </tr>
                ))}
              </tbody></table>
            )}
            {item.oe_codes.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-semibold text-gray-600">Оригінальні номери (OE)</p>
                <p className="flex flex-wrap gap-1.5">
                  {item.oe_codes.slice(0, 60).map(oe => (
                    <span key={oe.code_key + oe.car_model} className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-800" title={oe.car_model}>
                      {oe.code}{oe.car_model ? <span className="ml-1 font-sans text-gray-500">{oe.car_model}</span> : null}
                    </span>
                  ))}
                </p>
              </div>
            )}
            {item.applicability.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-semibold text-gray-600">Підходить до авто</p>
                <ul className="list-disc space-y-0.5 pl-5 text-xs text-gray-700">
                  {applicabilityLines(item.applicability).map(line => <li key={line}>{line}</li>)}
                </ul>
              </div>
            )}
            {!item.specifications.length && !item.oe_codes.length && !item.applicability.length && <p className="text-gray-500">Омега не має опису для цього товару.</p>}
          </div>
        )}
      </div>
    </Card>
  )
}
