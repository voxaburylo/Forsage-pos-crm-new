/**
 * Логотип «Форсаж» — один для всіх екранів: жовтий квадрат із чорною літерою F
 * (23.11.2026, слово власника: «буква F на жовтому фоні, а не блискавка»).
 * Той самий малюнок — у значку вкладки (public/favicon.svg) і в значку програми каси
 * (apps/desktop/build/icon.svg → icon.ico); тест brandLogo.test.ts стежить, щоб вони не розійшлися.
 */
export const BRAND_LOGO_PATH = 'M10 7h13v4.6h-8.2v3.5h7v4.4h-7V25H10z'

export function BrandLogo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className="shrink-0" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#FFD000" />
      <path d={BRAND_LOGO_PATH} fill="#0D0D0D" />
    </svg>
  )
}
