import type { AiUsage } from './aiApi'

const usd = (value: number) => '$' + (value < 0.1 ? value.toFixed(3) : value.toFixed(2))

/**
 * 24.11.2026 (план C2, «ціна розпізнавання до запуску»): перед запуском показати, скільки приблизно коштуватиме.
 * Беремо досвід саме цього магазину за 30 днів (медіана й «дорогий» запит), а не вигадану цифру. Усі фото
 * одного повідомлення йдуть одним запитом; багато фото — ближче до «дорогого». Даних мало — нічого не показуємо.
 */
export function recognitionPriceHint(usage: Pick<AiUsage, 'typical_usd' | 'heavy_usd' | 'sample'>, photos: number): string | null {
  const typical = Number(usage.typical_usd), heavy = Number(usage.heavy_usd)
  if (!Number.isFinite(typical) || !Number.isFinite(heavy) || typical <= 0 || heavy <= 0 || !usage.sample || usage.sample < 3) return null
  const photoText = photos > 0 ? `Фото: ${photos}. ` : ''
  const expected = photos > 2 ? heavy : typical
  return `${photoText}Орієнтовна ціна розпізнавання ≈ ${usd(expected)} (у вашому магазині зазвичай ${usd(typical)}, дорогий запит до ${usd(heavy)}; за ${usage.sample} запитами за 30 днів).`
}
